# Release notes

## Unreleased

### Local session storage

Browsing native sessions keeps a local index and reads the original transcript on demand. Orka saves a transcript snapshot when it needs exact bytes for sharing, an upload, or offline work. The desktop includes an [offline cleanup command](desktop-updates.md#reclaiming-old-session-snapshots) that reports reclaimable disk space before applying any changes.

### Devices

If you clear Orka’s local data or reinstall it, the same Mac now reuses its entry in Settings → Devices. If your Mac was first registered on an older version, the first reset after upgrading can leave two entries. Later resets reuse the new entry. On updated services, the older entry disappears from the list 30 days after its last sync.

With an updated service, you can see your computer name in your account’s Devices list. Other project members see “Mac”.
