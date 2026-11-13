# Suite identity rollout runbook

For the operator of a Home Base host. It takes a host from today's ingress (one TCP gateway, every app behind its own sign-in) to:
1. **the socket switchover**: every service hostname reaches nginx through its own Unix socket, every app listens on loopback or its own socket, sensitive apps run as their own users, and Home Base itself is reached at its own service hostname;
2. **the tailnet sign-in**: Home Base keeps a household directory with passkeys, and apps switch, one at a time, from their own sign-in to the member's tailnet identity.

Each part ends at a **stop point**: a state the host can stay in for as long as you like. Nothing here is required. A host that never starts keeps today's ingress, and its apps keep their own sign-in.

**Status.** Every step has run on a test VM. Part B has run on one production host; the four defects found there are fixed and folded into the steps and the recovery section below. Part C has run on the test VM only.

**Placeholders.** `<host>` is the host's MagicDNS name, `<tailnet>` the tailnet domain (`<name>.ts.net`), `<instance>` this household's instance name, `<app>` a catalog app ID, `<key>` a sensitive app's service key (`pulse`, `source`, `helm`, `bitcoin-accounting`).

## Rules

- **Rehearse on a test VM first.** A production host changes only after the same steps have passed there, including a rollback.
- **One host at a time, one step at a time.** Do each step's checks before the next step. When a check fails, stop and go to [Recovery](#recovery); don't improvise forward.
- **Have a way back in that doesn't depend on Serve:** an SSH session to the host, open before you start, over its tailnet IP or your LAN. Serve changes don't touch SSH.
- **Order matters both ways.** Forward: ingress, then Home Base, then apps. Back: apps to their own sign-in first, then Home Base, then ingress. Never give apps a TCP path while any of them trusts identity headers; Home Base refuses this too.
- **Keep the old credentials:** the Home Base admin passphrase (in a password manager) and every app's own passphrases and PINs, until each app has run on tailnet identity for your whole rollback window.
- **Never, from a root shell:**
  - write the whole Serve configuration back (`tailscale serve set-config --all`, `set-raw`) or reset it: it silently changes other services (see [Tailscale behaviors](#tailscale-behaviors-this-depends-on));
  - remove a Serve service Home Base manages by hand: the rollback can't put back what it didn't retire itself;
  - reopen `:3080` or a TCP listener to get back in;
  - edit `SOVEREIGN_AUTH_MODE` or `SOVEREIGN_HOMEBASE_UID` in an app's `.env`: use the Network page.

## Part A. Prepare

Nothing in Part A changes how anyone reaches the host.

### A1. Check the starting point

```sh
sudo grep -E '^HOME_BASE_(EXECUTION_MODE|STATE_DB|DATA_DIR|INSTANCE)=' /etc/sovereign-home/homebase.env
systemctl is-active homebase homebase-executor.socket
tailscale version
```

- `HOME_BASE_EXECUTION_MODE=executor`, and both units `active`. A host still on the legacy sudo installer moves to the executor first: [executor-app-runbook.md](executor-app-runbook.md), "Moving a legacy host".
- `HOME_BASE_STATE_DB` points under `/var/lib/sovereign-home/homebase`. Home Base keeps its other files beside it. (Before a fix from this rollout, a host with only `HOME_BASE_STATE_DB` kept them in its checkout, where they couldn't be written. Updating Home Base fixes that.)
- Tailscale 1.104.4 or later, the version these steps were checked on.

### A2. Back up, and write down where things are

```sh
D=/root/rollout-$(date +%F); sudo mkdir -p "$D"
sudo tailscale serve status --json | sudo tee "$D/serve-status.json" >/dev/null
sudo tailscale serve get-config --all | sudo tee "$D/serve-config.json" >/dev/null
sudo tar czf "$D/etc-nginx.tgz" /etc/nginx
sudo tar czf "$D/etc-sovereign-home.tgz" /etc/sovereign-home
DB=$(sudo grep -oP '^HOME_BASE_STATE_DB=\K.*' /etc/sovereign-home/homebase.env)
sudo python3 -c 'import sqlite3, sys; sqlite3.connect(sys.argv[1]).backup(sqlite3.connect(sys.argv[2]))' "$DB" "$D/home-base.sqlite3"
```

Then back up every installed app from its page in Home Base (**Backup**).

### A3. Read-only checks

```sh
tailscale status --self --peers=false                  # tagged? which tags?
sudo tailscale serve status --json                     # every service and node-level entry, with its frontend
sudo ss -ltnp                                          # who listens where: 0.0.0.0, 127.0.0.1, sockets
sudo nginx -T | grep -nE 'include|listen|stream'       # what nginx actually loads
systemctl list-units --type=service --no-legend --plain | awk '{print $1}' \
  | while read -r u; do echo "$u $(systemctl show "$u" -p User --value)"; done | grep ' sovereign'   # which user each app runs as
```

Must pass before Part B:
- [ ] `sudo tailscale serve get-config --all > /dev/null; echo $?` prints `0`. It fails with `root handler not set` when any service, even one that isn't Home Base's, has only a path handler. Home Base reads this command to see what it has published, so while it fails, every service looks unpublished and the Network page can't go past B5. Give that service a root handler, or wait for Home Base to stop depending on this command; don't start Part B.

Write down:
- [ ] **How you reach Home Base today.** Home Base listens on loopback `:3080` only; you reach it through Serve, either a node-level entry or the old managed service. If it is the old managed service, the cutover (B4) takes that way away before Home Base's new address exists (B5). Either way, set up the fallback below before Part B.
- [ ] **Serve services that aren't Home Base's** (a Lightning node, another app). Home Base never changes them; check they are unchanged at the end of Part B.
- [ ] **The old managed service** (usually `svc:home`, or one named after the host). The cutover retires it from this host, and a rollback puts it back. If it has already been removed by hand, a rollback can't restore it.
- [ ] **nginx's shape.** Does `/etc/nginx/nginx.conf` include `sites-enabled` inside its `http` block? Does any server block of yours include `/etc/nginx/sovereign-home.d/*.conf` (an adopted host)? Is there a `stream` block (an Electrum server, for example)? Step B3 depends on all three.
- [ ] Which units run as `sovereign`, and which as `sovereign-<key>`.
- [ ] Any node-level Serve entry on `:443`. A rollback needs nginx to bind 443, and that entry would block it.

### A4. Update Home Base, then every app

1. Update Home Base to the current release, from a root-owned clone of the repository:
   ```sh
   sudo git -C /root/homebase-src pull --ff-only
   sudo bash /root/homebase-src/install.sh --source-dir /root/homebase-src --repair
   systemctl is-active homebase homebase-executor.socket
   ```
2. Update each app from its page, one at a time. After the update, every app listens on loopback only (`HOST=127.0.0.1`) or, for socket apps, on its own socket. Anything that used an app's port directly (`http://<host>:3000/…`, a bookmark, a script) must now use its Home Base address.
3. Check each app is healthy on its page before the next. A red badge between steps 1 and 2 is real: health checks still reach an app on its old port until it is updated.

### A5. Move each sensitive app to its own user

A sensitive app installed before its own user existed still runs as the shared `sovereign` user. Its page's **Runs as** card says so. One app at a time, while it is still on its own sign-in:

1. Its page → **Runs as** → preview, then **Move to its own user** (type `MOVE`). It takes a safety backup, stops the app, creates `sovereign-<key>`, hands over its checkout, storage, backups and `.env`, rewrites its units, starts it and waits for it. Expect a minute or two of downtime. Don't create mounts inside the app's folders while it runs.
2. Check on the host:
   ```sh
   systemctl show <unit> -p User --value                       # sovereign-<key>, for every unit of the app
   sudo ls -la /run/sovereign-apps/<app>                        # drwxr-s--- sovereign-<key> www-data, and srw-rw---- app.sock
   sudo -u sovereign curl -s --unix-socket /run/sovereign-apps/<app>/app.sock http://localhost/<health>   # must fail
   sudo -u www-data  curl -s --unix-socket /run/sovereign-apps/<app>/app.sock http://localhost/<health>   # answers
   ```
   - [ ] `sudo -u sovereign` can't read its `.env` or list its checkout, storage or backups;
   - [ ] nothing listens on its old port (`sudo ss -ltnp`);
   - [ ] a page that reads data works, and its log has no `password authentication failed`;
   - [ ] update, backup and restart still work.
3. Then the next app.

If the move stops part way (a failure, a reboot), every other plan for that app refuses until **Move to its own user** runs again: it carries on from where it stopped, as the app's own user. Two known causes:
- *"… must be owned by root before … can be handed over"*: a host set up by the legacy installer, with a Home Base from before the fix, left `/var/lib/sovereign-home/<app>` owned by the shared user. `sudo chown root:root` and `sudo chmod 755` that one directory, then move again.
- A mount inside the app's folders: the move refuses any mount it finds there. Unmount it, then move again.

The move is one way: there is no move-back action. If the app misbehaves afterwards, **Restore** the safety backup the move took; the files stay with the new user, and the app stays on its socket. A problem with the socket itself is undone only by a Home Base release whose catalog sets the app back to `runtime.listen: 'tcp'`, followed by an update of the app. Neither path has been rehearsed.

### A6. Start Home Base's request guards in report mode (optional, start early)

The guards need a few days of reports before you enforce them in step C1, so start them now if you plan Part C:

```sh
echo 'HOME_BASE_REQUEST_GUARDS=report' | sudo tee -a /etc/sovereign-home/homebase.env
sudo systemctl restart homebase
journalctl -u homebase -n 50 | grep 'request guards: report'
```

Use Home Base as usual, from every browser and device that opens it.

**Stop point A.** Same addresses, same sign-ins. Apps on loopback or sockets, sensitive apps on their own users.

## Part B. The socket switchover

Plan a quiet hour. **Apps are unreachable from the cutover (B4) until their service is published (B5, B7):** usually a few minutes each, plus 35–40 seconds for each new hostname's first certificate. Home Base stays reachable the whole time.

### B1. Tailnet console

1. **Choose the instance name**: lowercase letters, digits and single dashes, at most 24 characters, starting with a letter (`smith`). It prefixes every service. **Changing it after the cutover isn't supported** (see [Tailnet rename](#tailnet-rename)), so choose carefully.
2. **Define the services** on the console's Services page, each with port `tcp:443`:
   - `svc:<instance>-home`: every low-friction app, by path (`/dinner/`, `/plan/`, …);
   - `svc:<instance>-homebase`: Home Base itself, and later all passkey management;
   - `svc:<instance>-<key>` for each **installed** sensitive app.
3. **Give this host its own tag**, owned by the administrator alone and held by no other machine, then add it to the host on the Machines page:
   ```jsonc
   "tagOwners": { "tag:<instance>-host": ["<administrator login>"] }
   ```
4. **Approve only that tag** for each service:
   ```jsonc
   "autoApprovers": { "services": {
     "svc:<instance>-home":     ["tag:<instance>-host"],
     "svc:<instance>-homebase": ["tag:<instance>-host"],
     "svc:<instance>-pulse":    ["tag:<instance>-host"]
   } }
   ```
   Never approve a tag that several hosts share. Any host holding it can become an approved standby, with a valid certificate for the hostname, and take the service's traffic when this host stops serving. Home Base refuses to publish while another host is approved, but the policy is the boundary.
5. **Review each service's existing approvals** and remove any host but this one. Tightening approvers doesn't revoke approvals that already exist.
6. **Grant members the addresses they use.** A member not granted an address gets a DNS error for it, not a refusal. All members using the Home Base launcher, including kids without passkeys, need `svc:<instance>-homebase`. It hosts their app list and onboarding welcome as well as passkey management; reaching it does not grant administrator access. App services still need their own network grants.
   ```jsonc
   { "src": ["group:family"], "dst": ["svc:<instance>-home", "svc:<instance>-homebase", "svc:<instance>-pulse"], "ip": ["tcp:443"] }
   ```
7. **Turn on Tailnet Lock** if it isn't on, so a leaked tagged auth key can't add a host without a trusted signature.

Done in another order, this host can lose its approvals while a stale host keeps its own.

### B2. Home Base settings

```sh
echo 'HOME_BASE_INSTANCE=<instance>' | sudo tee -a /etc/sovereign-home/homebase.env
sudo systemctl restart homebase
```

Home Base's configured domain must be the tailnet domain.

**How Home Base verifies the service hosts.** Choose one:
- **Automatic (recommended).** Create a trust credential (OAuth client, Settings → Trust credentials) with **Services: Read**, **Devices → Core: Read** and **Policy File: Read** only, and store it readable by Home Base alone:
  ```sh
  read -rs -p 'client id: ' ID; echo; read -rs -p 'client secret: ' SECRET; echo
  printf 'TS_OAUTH_CLIENT_ID=%s\nTS_OAUTH_CLIENT_SECRET=%s\n' "$ID" "$SECRET" \
    | sudo install -m 400 -o homebase -g homebase /dev/stdin /etc/sovereign-home/tailscale-api.env
  unset ID SECRET
  ```
  Home Base then lists every host of each service, standbys included, requires exactly one approved host (this one), and warns about shared approver tags and extra tag holders. **Never give it write scopes:** a credential that can approve hosts could approve an attacker's machine.
- **By hand.** Without a credential, you check each service's page in the console yourself and press **I checked the console: no other host is approved** on the Network page. A confirmation lasts 30 days; once Home Base is active (Part C) it needs the hardware key.

### B3. nginx (adopted or custom hosts only)

Skip this if `/etc/nginx/nginx.conf` already includes `sites-enabled` in its `http` block and none of your own server blocks include `/etc/nginx/sovereign-home.d/*.conf`. The cutover checks both and refuses, before changing anything, if either is wrong.

Otherwise, **right before B4**, because your apps stop answering through your own site from the moment you save this:
1. Remove `include /etc/nginx/sovereign-home.d/*.conf;` from your own server block. Keep the rest of the site. Kept, it would go on serving apps over TCP, where any local process can pretend to be a member.
2. Inside the `http` block of `/etc/nginx/nginx.conf` add:
   ```nginx
   include /etc/nginx/sites-enabled/sovereign-home*;
   ```
   **Use the pattern, with the `*`.** The gateway file doesn't exist until the cutover writes it, and nginx refuses an include of a missing file but accepts a pattern that matches nothing yet. Keep everything else in the file, including any `stream` block.
3. `sudo nginx -t && sudo systemctl reload nginx`.

### B4. Cut over

**First, a way into Home Base that doesn't depend on Serve.** From your computer, leave this running:
```sh
ssh -N -L 3080:127.0.0.1:3080 <you>@<host>
```
Open `http://localhost:3080/` and check that you can unlock admin there. An open SSH shell alone isn't enough: you need the Network page to publish Home Base's new service.

Then: Network page → **Cut over to per-service sockets**. In one job it:
- creates the socket directories (`/run/sovereign-serve`, root only; `/run/homebase-identity`, Home Base and nginx);
- writes the socket gateway (one server block per service, no TCP listener) and the identity check;
- re-renders every installed app's nginx snippet for its service;
- reloads nginx, and checks that nginx really loaded the gateway and every service socket answers;
- retires the old managed service from this host. Serve services Home Base didn't create are not touched.

**Home Base stays on loopback `:3080`.** It moves in B6, once its new address works. If you reached it through the old managed service, use the SSH tunnel above until B5.

Check:
- [ ] The job succeeded. Its last line names the instance, `Home Base on port 3080`, and the app snippets it wrote.
- [ ] `sudo nginx -T | grep -c 'sovereign-ingress: sockets'` prints `1`.
- [ ] `sudo ss -ltnp | grep -E ':(80|443) '` shows only tailscaled's listeners on the host's tailnet addresses.
- [ ] `journalctl -u homebase -n 50 | grep 'identity lookups on /run/homebase-identity/identity.sock'`.

If it fails, see [Recovery](#recovery). **Roll back ingress** on the same page undoes it.

### B5. Publish Home Base's service, and open it

Network page → `homebase` row → **Publish**. Home Base refuses while another host is approved for it. Then:
- [ ] The row shows `verified` (automatic) or, after you confirm it by hand, `confirmed`.
- [ ] `https://<instance>-homebase.<tailnet>/` opens Home Base from your own device. The first certificate takes 35–40 seconds. With an API credential Home Base fetches it while publishing; without one, your first visit waits for it (up to a minute).

**Don't go on until that address loads.** If it doesn't: is this host approved for the service in the console, and does your device's grant include it?

### B6. Move Home Base to its socket

Network page → **Move Home Base to its socket**. It refuses until its service is published on this host and nginx reaches Home Base through it. With an API credential it also opens the new address itself; without one, you confirm that you opened it.

From then on `:3080` is no longer Home Base. Pages redirect to `https://<instance>-homebase.<tailnet>/` (same path), other requests get `421 HOME_BASE_MOVED`, and only `GET /api/homebase/health` still answers there, for the installer. That closes the loopback port to a local process that could pass as a member.

- [ ] `https://<instance>-homebase.<tailnet>/` works, signed in as before.
- [ ] The old `:3080` address redirects to it.

### B7. Publish the other services

`home`, then each sensitive app, one at a time, from the Network page. After each:
- [ ] `verified` (or `confirmed`);
- [ ] `https://<service>.<tailnet>/<app>/` loads each app on it.

### B8. Update every app, so each learns its new address

The cutover rewrote nginx, not the apps' `.env` files. Update each app from its page. Then each app's addresses (`APP_URL`, `APP_PUBLIC_URL`, `HELM_PUBLIC_URL`, local font URLs) use its service hostname.

**External callbacks.** An update re-renders callback addresses, unless the app keeps them:
- **Family Plan:** `GOOGLE_REDIRECT_URI` moves to `https://<instance>-home.<tailnet>/plan/api/google-calendar/oauth/callback`. Add it in the Google Cloud console before anyone reconnects a calendar. Keep the old one listed through the rollback window.
- **Family Pulse:** `PLAID_OAUTH_REDIRECT_URI` and `PLAID_ENV` are kept as you set them. Plaid uses the redirect URI only inside webviews (an iOS wrapper); desktop and mobile browsers use a popup. Whether to register a tailnet address with Plaid, or keep a public callback, is your call: Plaid doesn't separate sandbox from production redirect URIs.
- **Helm:** `SCHWAB_CALLBACK_URL` is yours to set and updates keep it. If it points at the host's old address, change it at Schwab and in Helm together.

### B9. Verify

From a member's device, and from the host. The full list, including forged-header and cross-site checks, is in [Verification checklists](#verification-checklists); these are the ones to do now:
- [ ] Every installed app loads at `https://<service>.<tailnet>/<app>/`, and `…/<app>` (no slash) redirects to `…/<app>/` on the same hostname, never `localhost`.
- [ ] An app's mount on another service's hostname is refused (404).
- [ ] `curl -k https://127.0.0.1/` on the host fails: no TCP listener.
- [ ] Each Serve service you recorded in A3 that isn't Home Base's is unchanged (`sudo tailscale serve status --json`).
- [ ] Update, backup and restart work for one app of each kind.

### B10. Tell members

New addresses; update bookmarks and the iOS wrapper's start URL.

**Stop point B.** Every service on its own hostname over sockets; Home Base on its socket; every app still on its own sign-in. A host can run like this indefinitely. Retire the `:3080` redirect later (Part D).

## Part C. The tailnet sign-in

### C1. Enforce Home Base's request guards

After A6's few days:
```sh
journalctl -u homebase | grep 'would refuse'
```
Each line names the method, path, reason, `Origin` and `Sec-Fetch-Site`. Home Base's own pages should cause none; a line you don't expect names the page or client to fix first. Then set `HOME_BASE_REQUEST_GUARDS=enforce` and restart Home Base.

- [ ] Home Base's pages, jobs and settings work as before, and a link to Home Base from another app opens it.

### C2. Health alerts

Config → **Health alerts**: tick **Enable critical health alerts**, set the **Health alert webhook URL**, press **Save config**, then **Send test alert** (it uses the saved settings), and check that it arrives. With alerts on, opening recovery sends a notice naming the tailnet account that did it, which is how you learn if it wasn't you. A notice that fails to send is logged, and doesn't stop recovery.

### C3. Turn on the household directory

```sh
sudo sed -i '/^HOME_BASE_IDENTITY_PREVIEW=/d' /etc/sovereign-home/homebase.env
echo 'HOME_BASE_DIRECTORY=on' | sudo tee -a /etc/sovereign-home/homebase.env
sudo systemctl restart homebase
journalctl -u homebase -n 50 | grep 'household directory: publishing'
```

Home Base comes up in **setup**. Until setup is finished, it runs no privileged plan or setting change, and every page says so.

### C4. Set up the administrator

On `https://<instance>-homebase.<tailnet>/admin`:
1. Unlock with the passphrase. Your tailnet identity is recorded as the administrator.
2. Under **Passkeys**, register:
   - a synced passkey, for daily use;
   - a hardware security key, with **It's a hardware security key** ticked (it must prove its maker; only keys from a vendor sovereignAuth pins count);
   - a second hardware key, kept offline as a spare.
3. **Finish setup with my hardware key.** Home Base becomes **active**. That tap also opens admin for 8 hours.
4. **Without an API credential, confirm each service again.** Confirmations from Part B were made with the passphrase; once Home Base is active, an app can switch only on a service confirmed with the hardware key. On the Network page press **I checked the console: no other host is approved** for each service, after checking the console again. Until you do, **Use tailnet identity** doesn't appear.
5. Check that the passphrase now opens only recovery (**Enter recovery**). From now on **Unlock admin with a passkey** opens admin, and **Lock admin** closes it in that browser. Adding or removing an administrator passkey, and every privileged plan, asks for the hardware key each time.

Home Base signs its sessions with its own key, beside its database. Rotate it under **Signing key** on the Passkeys card (hardware key each time); tick **It may have been exposed** only if it may have been, because that ends every session at once.

### C5. Add members, and enroll passkeys only when needed

1. Ask the person to open `https://<instance>-homebase.<tailnet>/` from their own device, signed in to the tailnet as themselves. The welcome page names their account and explains that the administrator must add them. Once ingress has observed the visit, the page confirms that the account is visible in Members for a day. If it does not, check their tailnet connection and Home Base service grant before continuing.
2. Admin → **Members** → **Add a member** → **Check again**. Pick their role (**parent** or **kid**: there is no default) and **Add member**. Their visible welcome page checks every 10 seconds while awaiting admission, then switches to **Your apps**. They can also select **Check again**. Only the administrator grants membership and app access.
3. Passkeys are not required to discover apps or use low-friction apps. Kids' supported, scoped views in sensitive apps also stay at tailnet level (D7). For a member who needs passkey-protected access, use **Issue enrollment code** on their row. The code works once, for 15 minutes, only on Home Base's own address. Give it to them in person; they use **Have a passkey enrollment code?** on Home or open Admin, enter it under **Passkeys**, and register one. Enrollment does not grant membership or app access.

By default a member reaches every installed app except trading and Bitcoin accounting, which only the administrator reaches. To change one member's apps, open **Change apps** in their row on the Members card and choose the default or a list of the apps installed here. A change ends the passkey confirmations they gave apps; an app asks again when it needs one.

### C6. Switch each app

Per app, starting with a low-friction one:
1. **Update it** to a version that supports tailnet identity (its Network row stops saying "this version can't use tailnet identity yet").
2. Network page → its row → **Use tailnet identity**, with the hardware key. Home Base offers it only when the host is cut over, the app's service is published and verified (or confirmed), and the app supports it. The executor checks again, then writes the mode into the app's `.env` and restarts it. It refuses, saying why, when:
   - the app isn't on its socket (update it);
   - its address isn't its service hostname yet (update it: step B8);
   - a sensitive app still runs as `sovereign` (step A5).
3. **Link members**, once: each parent opens `https://<service>.<tailnet>/<app>/`, lands on its **link** page, and matches each household member to the app's own person. A sensitive app asks for a passkey first.
4. Check:
   - [ ] each member lands as themselves;
   - [ ] a kid sees only what kids see, and parent-only actions refuse them;
   - [ ] someone without access sees "ask whoever runs Home Base";
   - [ ] a sensitive app asks parents for a passkey, about once a month per device.
5. Back out: **Return to its own sign-in** on the same row. Its own passphrases and PINs still work.

**Stop point C.** Members sign in with their tailnet identity in each switched app.

## Part D. Clean-up

After the rollback window:
- Retire the `:3080` redirect: `HOME_BASE_LOOPBACK=off` in `homebase.env`, then restart Home Base. Nothing listens on `:3080` afterwards, and the installer checks health on the socket. A rollback of the ingress opens it again.
- Remove the old provider callback URLs you kept listed in B8.
- Retire an app's own passphrases and PINs only after it has run on tailnet identity for the whole window. That ends its way back to its own sign-in.
- Remove rehearsal-only grants, services, tags and credentials.
- Keep the Home Base passphrase: it opens setup and recovery.

## Recovery

By symptom. Each of the first four happened on the first production host, and the fix is now in Home Base; if you meet one, the host's Home Base is older than this runbook, so update it first.

**The cutover refuses: "nginx wouldn't load the socket gateway".** nginx.conf doesn't include `sites-enabled` in its `http` block. Do step B3, then run the cutover again. (Before the fix, the cutover went ahead, nginx ignored the gateway and still reloaded, and Home Base recorded success.)

**The cutover refuses: a server block "includes /etc/nginx/sovereign-home.d".** Your own site still serves the apps over TCP. Step B3.1.

**A publish or the cutover fails with "want to serve "http", but port 443 is already serving "https" for svc:…"** naming a service that isn't Home Base's. An older Home Base wrote the whole Serve configuration back, which Tailscale reads differently from what it exported. Update Home Base: it now changes one service at a time. If you must publish by hand, do only that service:
```sh
sudo tailscale serve --bg --yes --service=svc:<instance>-<key> --https=443 unix:/run/sovereign-serve/<key>.sock
```
Never clear or rewrite the other service.

**"I checked the console…" fails with `ENOENT` on `ingress-confirmations.json`.** An older Home Base looked for its files in its checkout. Update Home Base. If it persists, set `HOME_BASE_DATA_DIR=/var/lib/sovereign-home/homebase` (the directory holding `HOME_BASE_STATE_DB`) and restart Home Base while no job runs. Never make the checkout writable.

**Home Base can't be reached: `:3080` redirects and the new address doesn't load.** (Before the fix, the first cutover could move Home Base before its new service existed.) From the root shell; this opens no TCP path:
1. Publish its service by hand:
   ```sh
   sudo tailscale serve --bg --yes --service=svc:<instance>-homebase --https=443 unix:/run/sovereign-serve/homebase.sock
   ```
2. In the console, check this host is approved for that service, and your device's grant includes it.
3. `sudo nginx -T | grep -c 'sovereign-ingress: sockets'` must print `1`. If `0`, nginx isn't loading the gateway: step B3.2.
4. `sudo nginx -t && sudo systemctl reload nginx`, then `sudo journalctl -u nginx -n 5` to check the reload wasn't rejected. (`nginx -T` shows the files on disk, not what the running workers loaded.)
5. Wait 35–40 seconds for the first certificate, then open the address.

**A new address gives a DNS error.** The member's grant doesn't include that service: addresses nobody is granted aren't sent to their devices at all (B1.6).

**A new address times out on first use.** The first certificate takes 35–40 seconds. Otherwise the host isn't approved for the service yet, or another host is (B1.5).

**A service you published by hand waits for approval.** It had no approver when the host first advertised it. Adding the approver afterwards doesn't approve it; approve it on the service's console page. To avoid this, for a service added later (a sensitive app installed after Part B), define it, add its approver and add it to the members' grant, all before publishing.

**nginx won't reload, or `nginx -t` fails.** Fix it before any rollback, move or re-run: Home Base's parts of the configuration are fixed, so the problem is in something already there (your site, a snippet, a certificate). A rollback whose reload failed has already written the TCP gateway; fix nginx and run the rollback again.

**Home Base refuses something its own pages or a tool you use need (`request_refused`) after C1.** Set `HOME_BASE_REQUEST_GUARDS=report` and restart Home Base: requests go through again, and the log says what enforce refuses. Fix that page or client, then enforce again. `off` removes the guards entirely; once members use passkeys, the guards are what stops a page on another hostname from acting on Home Base as them, so prefer `report`.

**An app won't start after Use tailnet identity.** It refuses to start on a bad configuration rather than starting open. `journalctl -u <unit> -n 30` names the setting. **Return to its own sign-in** brings it back at once; then update the app and switch again.

**An app shows "can't check who you are right now".** It can't read the household directory. Check `systemctl is-active homebase` and `journalctl -u homebase | grep 'household directory'`. The app picks the directory up again by itself.

**A member sees "doesn't know you yet".** They aren't a member, are disabled, or the app isn't in their app list (C5). **"Almost there"**: a parent hasn't linked them in that app yet (C6.3).

**The administrator has lost their passkeys.** **Enter recovery** with the passphrase on Admin, then register new administrator keys and finish with a hardware key. If the passphrase is lost too, see [Reset](#reset-root-shell).

**Never downgrade the executor** while Home Base is on its socket: an older executor puts nginx back on `:3080` without updating its record. If it happened, upgrade the executor again, check `sudo nginx -t`, and run the cutover again.

## Rollback

Undo in reverse order, as far as you need:
1. **Apps:** **Return to its own sign-in** for every app on tailnet identity. Home Base counts an app as trusting identity headers from the moment its switch starts, so the ingress rollback refuses until every app is back, even after a failed switch.
2. **Home Base identity. Read this before rolling back the ingress on a host whose directory is active (Part C).** Active Home Base opens admin only with a passkey check, and passkeys work only on Home Base's socket. After an ingress rollback Home Base is back on `:3080`, so nobody can open admin there, and the passphrase opens only recovery. There is no supported way back from that yet. Until there is, treat an ingress rollback after Part C as unsupported: back out apps (step 1) and stop there. Turning the directory off after it was active hasn't been rehearsed either.
3. **Ingress** (hosts that never reached Part C): Network page → **Roll back ingress** (`ROLLBACK`). It re-renders every app's snippet for TCP, restores the TCP gateway, puts Home Base back on `:3080`, takes the socket services down and puts back the old managed service as the cutover retired it. It refuses while any app's `.env` has `SOVEREIGN_AUTH_MODE` other than `local`, including a hand edit. A node-level Serve entry on `:443` blocks nginx from binding; remove it and restart nginx. Then **update every app again**, so its addresses (and callbacks, B8) point back at the old ones, and check its external callbacks still work.
4. **Sensitive apps' own users** stay: the move is one way. That is safe under either ingress.

## Reference

### Verification checklists

After Part B, from a member device and the host:
- [ ] `https://<service>.<tailnet>/<app>/` loads for each installed app; `…/<app>` redirects to `…/<app>/` on the same hostname.
- [ ] Every mount requested on every other service's hostname is refused (404), and a hostname sent to another service's address gets 421.
- [ ] Forged `X-Sovereign-*`, `Tailscale-User-*`, `X-Forwarded-For` and `X-Forwarded-Host` headers never reach an app, on every location, including sidecar routes.
- [ ] With Home Base stopped, requests are refused (500), and work again once it's back.
- [ ] `curl -k https://127.0.0.1/` on the host fails.
- [ ] A non-root local user can't connect to any nginx socket or to the identity socket.
- [ ] A local process requesting the host's own service URL gets no member identity (`curl --resolve <service>.<tailnet>:443:<service IP>`).
- [ ] A tagged host and an unknown login get no identity.
- [ ] `/_sovereign/auth/` is 404 on `svc:<instance>-home`.
- [ ] Sensitive and Home Base responses carry `Content-Security-Policy: frame-ancestors 'none'`, including 404s.

After C1 (request guards) and C6 (an app switched):
- [ ] From a page on `svc:<instance>-home`, a fetch, form post, image, script and iframe to a sensitive hostname or Home Base are refused **on the server** (its log, not just the browser).
- [ ] A top-level link from the home hostname to a sensitive page opens it and changes nothing.
- [ ] A request with no `Sec-Fetch-Site` header is refused on sensitive and Home Base hostnames.
- [ ] A cookie set on the home hostname with `Domain=<tailnet>` is ignored by every sensitive app and by Home Base.
- [ ] A privileged plan asks for the hardware key every time, and a token for one plan can't run another.
- [ ] Revoking a passkey refuses its session within one snapshot interval.
- [ ] Recovery: the passphrase, while active, ends sessions and allows only re-enrollment.

Probing an app through nginx with curl needs the fetch metadata a browser sends, once each:
```sh
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Sec-Fetch-Site: none' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Dest: document' https://<service>.<tailnet>/<app>/
```
Without it a sensitive hostname answers `403 fetch_metadata_missing`, which is correct.

### Publishing rules Home Base enforces

- **Directory off:** a service may be published once no other host is approved for it. No app can switch to tailnet identity.
- **Setup and recovery:** only `svc:<instance>-homebase` may be published, so the enrollment surface exists.
- **Active:** publishing needs "no other host approved"; tailnet identity needs the service verified, or confirmed with the hardware key.

### Tailscale behaviors this depends on

Checked on 1.102.4 (2026-10-27) and 1.104.4 (2026-11-06).
- Change one service at a time: `tailscale serve --bg --yes --service=<svc> --https=443 <target>` and `tailscale serve clear <svc>`. Each leaves every other service and node-level entry unchanged and is safe to repeat. Publishing also advertises a drained service.
- **Never write the whole configuration back** with `set-config --all` or `set-raw`. The export names only the upstream, so an HTTPS frontend with an HTTP upstream exports as `http://…`, which `set-config` reads as plain HTTP: it refuses that over a live HTTPS port, and, if the service has since been removed, silently brings it back on plain HTTP. `set-raw` also drops node entries and leaves services with null endpoints.
- `tailscale serve get-config --all` exits 1 if any service has only a path handler (`root handler not set`). `tailscale serve status --json` still answers, and only it shows a port's frontend.
- A socket target is stored as `"tcp:443": "https://unix:<path>"`.
- A service host can't resolve its own service names unless the policy grants it access; use the service address from the API.
- tailscaled itself listens on the host's tailnet addresses on 443; any other 80/443 listener is a TCP path into nginx.

### Reset (root shell)

When the administrator has lost both their passkeys and the passphrase, or recovery itself is stuck: `sudo homebase admin reset`. It asks for a new passphrase and a typed `RESET`, revokes every administrator credential and session, ends every session (global epoch), and returns Home Base to setup, audited. The administrator stays the same tailnet account; if that account is gone, `sudo homebase admin reset --administrator <login>` lets that login become the founder instead.

### Tailnet rename

**Not supported yet.** On a cut-over host, the executor refuses a cutover under a different instance name or tailnet domain, and Home Base's domain setting is locked. Nothing rebinds passkeys either: they belong to the tailnet domain, so a renamed tailnet would leave every passkey unusable. Don't rename the tailnet, or change the instance, on a host that has been cut over. Changing the instance alone wouldn't affect passkeys, but it renames every service and isn't supported either.

## Instance-isolated passkeys

This procedure applies only to a reviewed, compatible release, in a separately authorized rollout. It does not authorize deploying a draft branch to production. Rehearse first on two disposable suites with independent identity databases, the actual hardware key, and the deployed Node/Python/SQLite versions.

### What changes, and what does not

New registrations have a persisted opaque account handle per member in each independent suite. The tailnet domain remains the WebAuthn RP ID. The instance tag controls hosting policy; it is not a WebAuthn domain. New provider-facing display names include the suite instance, without changing the Tailscale login or authorization ID.

- **Isolated** means the credential uses the new account namespace.
- **Legacy (compatible)** means an existing credential still uses its original ID-derived handle. Working legacy keys do not have to be re-registered. A NULL stored handle on a legacy row is intentional, not corruption; the member's new enrollment handle does not rewrite that key.
- **Invalid account metadata** identifies a malformed stored credential record, not proof of a damaged physical key. Status/recovery remain available. An enrollment-metadata warning can instead mean missing member metadata or a well-formed mismatch on either side.
- Stored rows, attestation kind and D11 counts are not proof that the device still holds its private credential. Check the particular credential's fresh use. Do not reset the physical key to fix this incident.
- A copied identity database copies account handles. It is not a way to create an independent rehearsal suite. Same-suite host moves/restores preserve those handles. Tailnet/domain changes are still a separate unsupported migration.

### Roll out without flipping the working key again

1. Use fresh ordinary passkey checks to identify the **working** and **overwritten** suites; do not assume their roles from their names or yesterday's timestamps. Check hardware and synced providers separately. An assertion does not replace a credential; registration can. If neither suite works, use the established recovery procedure rather than this one-live shortcut.
2. Keep SSH/root access and verify the recovery passphrase without exposing it. Take protected SQLite/config/signing-key backups using Part A. Freeze enrollment of the shared key through every unpatched instance throughout the coordinated window.
3. Upgrade the overwritten suite to the reviewed compatible build **before** entering recovery. Install its locked dependency and verify the running service restarted; files changed on disk are not proof the daemon loaded them. `PASSKEY_LIBRARY_MISMATCH` means stop and repair the dependency/process installation, not reset a key. In Admin, explicitly enter recovery with the passphrase from the administrator's tailnet account. Register and freshly check the missing hardware credential. Keep and freshly verify any second credential that still works; register another only if needed to meet D11. Do not force a working local legacy phone/key to re-enroll: ordinary exclusions intentionally protect it. Record any new entries/IDs and confirm their `lastUsedAt` or the status check's `credentialId`, not just a generic success from a different older entry.
4. After each new registration, verify the working suite's old hardware/synced credential still checks. Both devices/providers may have lost old entries: do not count ghost rows as a replacement. Newly registered entries should say **Isolated**; retained legacy entries remain **Legacy (compatible)**. Registration options supply an instance-labelled display name; the provider controls how it presents that text.
5. Only after confirming usable replacements, remove the overwritten suite's obsolete entries. During setup/recovery the Passkeys **Remove** button uses the existing passphrase-authorized Directory revoke route; it does not request a hardware confirmation. In active Home Base, administrator removal still uses the ordinary hardware-every-time route and preserves D11. Then finish recovery with a fresh hardware check.
6. Upgrade the working suite to stop new legacy issuance. Do not force its still-working key into recovery or re-enroll it. Verify both suites, their sensitive-app origins, and checks after service restarts. Keep the remaining legacy entries inventoried.
7. **Stop** if the real key unexpectedly treats an overwritten ID as excluded, or enrollment on one suite still breaks the other. Do not weaken exclusions or delete working access just to obtain a passing test. Same-device enrollment on the live legacy suite is intentionally duplicate-protected.

This is accidental replacement prevention between cooperating suites, not a new browser-enforced boundary against hostile sibling origins sharing the RP ID. Physical/provider behavior is an acceptance gate, not something the software authenticator proves.

### Diagnose metadata without exposing keys

The administrator sees the first-isolated-credential warning once any member has issued an isolated credential. That timestamp is informational server enrollment metadata; it is not cryptographic clock proof. After issuance, a pre-compatibility binary is an unsupported downgrade: it may reject new assertions and still issue shared legacy handles. Old binaries have no new startup guard. The warning and release/runbook discipline enforce this floor operationally.

For root-only, read-only comparison, set `DB` to the service's effective configured database (the following is the default). The output contains labels/IDs to redact before sharing, but no public-key bytes, signing key, passphrase hash, token or raw account handle:

```sh
DB=/var/lib/sovereign-home/homebase/home-base.sqlite3
sudo python3 - "$DB" <<'PY'
import base64, hashlib, json, pathlib, sqlite3, sys
c = sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri() + '?mode=ro', uri=True)
c.row_factory = sqlite3.Row

def fingerprint(value):
    if value is None:
        return 'unset'
    try:
        raw = base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)
        if len(raw) != 32 or base64.urlsafe_b64encode(raw).decode().rstrip('=') != value:
            return 'invalid'
        return hashlib.sha256(raw).hexdigest()[:16]
    except (ValueError, TypeError):
        return 'invalid'

print(dict(c.execute('SELECT state, webauthn_v2_issued_at FROM identity_household WHERE id=1').fetchone()))
for row in c.execute('''SELECT m.user_id, m.login, m.webauthn_user_handle AS member_handle,
 c.label, c.kind, c.handle_format, c.webauthn_user_handle AS credential_handle,
 c.revoked_at, c.last_used_at FROM identity_members m
 JOIN identity_credentials c ON c.member_id=m.member_id ORDER BY m.user_id,c.created_at'''):
    item = dict(row)
    item['member_fingerprint'] = fingerprint(item.pop('member_handle'))
    stored = item.pop('credential_handle')
    item['credential_fingerprint'] = 'legacy: ID-derived' if item['handle_format'] == 'legacy-v1' else fingerprint(stored)
    print(json.dumps(item))
PY
```

Compare **all** isolated rows owned by the affected member, revoked ones included. A valid-looking mismatch may be in the member row or a credential row; equality/shape alone does not establish which copy is right. Revoking a well-formed mismatched historical row does not clear the enrollment warning, because the history still protects against silently creating another account. Fingerprints are diagnostic hints, not values to write back.

### Corruption exits and restoring the same account

- If a credential has malformed account metadata, enter explicit administrator recovery and remove the identified invalid entry with **Remove**. This is a different failure from ordinary authenticator exclusion: clearing a corrupt record may be necessary **before** options can be generated. Keep other working access, enroll/check the needed replacements, and activate with hardware. An active administrator can use the existing Directory API to revoke an affected non-admin credential; no new policy bypass is introduced.
- A NULL member handle from an old writer with no isolated history is allocated on a compatible restart; the error says so. With isolated history, a missing, invalid or inconsistent member handle is **not** reallocated, even after all those credentials are revoked. Existing valid credential checks may remain usable, but enrollment is paused.
- `homebase admin reset` is not a namespace repair: it retains the member/account and revokes administrator credentials. Do not reset the hardware key, generate a replacement member handle, relabel credential handles or clear the rollback marker to hide the problem.

A proven same-account restoration is an **offline, maintainer-assisted maintenance operation**, not an in-product rebind command:

1. Stop Home Base in an approved maintenance window and take a fresh protected SQLite backup. Confirm the affected stable member ID/login and the exact **original** canonical 32-byte handle from a known-good backup. Current isolated rows (including revoked rows) provide supporting evidence; if they disagree or the original cannot be proven, stop for case-specific recovery. Do not guess between a damaged member value and a damaged credential value.
2. Under one `BEGIN IMMEDIATE` transaction, verify that every owned isolated row agrees with that proven original handle. Preserve all credential IDs, verification keys, counters, revocations, roles, epochs and signing keys. For a member-only repair, capture the exact SQL of `identity_member_handle_immutable`, temporarily remove **only that guard inside the transaction**, perform a parameterized update of **one** `identity_members.webauthn_user_handle`, and recreate the captured guard before committing. Keep canonical/unique constraints active. Roll back the entire transaction, including DDL, on any failed validation or write. Never leave guards disabled on a running service.
3. Restart the compatible build, which refreshes its managed guards, and re-check each suite/credential before further enrollment. Record the maintenance reason, affected member, backup/version references and check results without logging handle bytes. If a credential row also needs restoration, this member-only procedure must abort; arrange case-specific restoration from trusted metadata, not arbitrary relabeling or a blind whole-database rollback.

The transaction/abort/guard-restoration recipe is exercised only on disposable metadata fixtures in `test/passkey-account-store.test.js`. It is not a tested production disaster-recovery service. Restoring database rows cannot restore a private credential removed from a physical key, and restoring a whole old database can also roll back authorization/revocation state; neither is a routine rollback shortcut.
