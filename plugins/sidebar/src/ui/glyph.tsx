/** Small original outline glyphs; inherit the host theme and text colour. */
export function Glyph({ kind }: {
    kind: 'folder' | 'open' | 'project' | 'pin' | 'eye' | 'search' | 'sliders' | 'inbox' | 'chevron' | 'split' | 'info' | 'activity' | 'warning' | 'clock' | 'dot' | 'stop' | 'plus' | 'eye-off';
}) {
    const paths = {
        folder: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
        open: 'M3 10V5a2 2 0 0 1 2-2h5l2 3h7v4M3 10h18l-3 11H3V10Z',
        project: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v3M13 13v5a3 3 0 0 0 3 3h2M10 13a3 3 0 1 0 6 0 3 3 0 0 0-6 0M18 21a2 2 0 1 0 4 0 2 2 0 0 0-4 0',
        pin: 'm16 3 5 5-4 2-3 6-3-3-6 8 5-9-3-3 6-3 3-3Z',
        search: 'M3 10a7 7 0 1 0 14 0 7 7 0 0 0-14 0Zm12 5 6 6',
        sliders: 'M3 7h4m6 0h8M3 17h8m6 0h4M7 7a3 3 0 1 0 6 0 3 3 0 0 0-6 0Zm4 10a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z',
        inbox: 'M3 13 6 5h12l3 8v6H3Zm0 0h5l2 3h4l2-3h5',
        chevron: 'm9 5 7 7-7 7',
        split: 'M3 5h18v14H3Zm9 0v14m3-7h4m-2-2v4',
        info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-11v6m0-10h.01',
        activity: 'M2 12h4l3-6 5 12 3-6h5',
        warning: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-15v6m0 4h.01',
        clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-16v6l4 2',
        dot: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
        stop: 'M6 6h12v12H6Z',
        plus: 'M12 5v14M5 12h14',
        'eye-off': 'm3 3 18 18M10.5 10.5a2 2 0 0 0 3 3M5 6.5A16 16 0 0 0 2 12s4 7 10 7a10 10 0 0 0 4.5-1.2M9 5.5A9 9 0 0 1 12 5c6 0 10 7 10 7a16 16 0 0 1-3 3.5',
        eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm7 0a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
    };
    return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d={paths[kind]}/></svg>;
}
