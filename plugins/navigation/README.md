# Makosh Navigation

Experimental navigation provider for BB. Select it under Settings → Appearance → Navigation after installation. Installation is a separate owner action.

Edit the layout in the plugin settings: create groups or separators, rename groups, choose an icon, reorder and move entries, hide or restore them. Nested groups replace the contents of one popup with a Back button.

Valid edits autosave serially to plugin SQLite with revision checks. A write failure or conflict keeps the draft in frontend memory; retry explicitly overwrites the current revision. Reloading the page loses unconfirmed drafts. One layout is shared across this BB installation.

The catalogue is supplied by the active rail. When this provider is inactive, settings show only the last catalogue from this frontend session. Corrupt or newer documents are protected from writes; reset/recovery UI is not implemented yet.

Checks: `npm run check`; bundle: `npm run build`. Browser component acceptance covers nested menus, focus on entry/Escape, icon search, hide/restore, confirmed reset and a 390px viewport. Settings includes an interactive preview; group badges use a dot without summing counts. Live BB acceptance remains pending. Reset currently restores a valid saved layout only; recovery from corrupt/newer documents remains protected.
