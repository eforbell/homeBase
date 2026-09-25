// Same archive naming as the legacy backup planner, so both modes read each other's backups.
function archiveNameFor(generatedAt) {
  return generatedAt.replaceAll(':', '').replaceAll('-', '').replace('.000', '').replace('.', '');
}

module.exports = { archiveNameFor };
