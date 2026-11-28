import { definePluginApp, useBbNavigate, useRpc, type PluginFileOpenerProps } from '@get-bb/plugin-sdk/app';
import { useEffect, useState } from 'react';
import type { methods } from './wire.ts';

type Copy = {hostId: string; path: string};
const opener = 's9-private-editor';
let session: Copy | undefined;

function Probe() {
  const rpc = useRpc<typeof methods>();
  const navigate = useBbNavigate();
  const [copy, setCopy] = useState<Copy>();
  const [status, setStatus] = useState('');
  async function create() {
    try {
      session = await rpc.call('create', null);
      setCopy(session);
      setStatus('Copy ready');
    } catch (error) { setStatus(String(error)); }
  }
  function open(explicit: boolean) {
    if (!copy) return;
    const accepted = navigate.experimental_openFilePreview({
      target: {kind: 'host', ...copy},
      location: null,
      ...(explicit ? {opener} : {}),
    });
    setStatus(accepted ? (explicit ? 'Editor accepted' : 'Preview accepted') : 'Open refused');
  }
  return <main>
    <button onClick={create}>Create synthetic copy</button>
    <button disabled={!copy} onClick={() => open(false)}>Open without explicit opener</button>
    <button disabled={!copy} onClick={() => open(true)}>Open in S9 editor</button>
    <p role="status">{status}</p>
  </main>;
}

function Editor({path, source, Original}: PluginFileOpenerProps) {
  if (source.kind !== 'host' || path !== session?.path) return <Original />;
  return <PrivateCopy />;
}

function PrivateCopy() {
  const rpc = useRpc<typeof methods>();
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  async function read() {
    try {
      setText(await rpc.call('read', null));
      setStatus('Read via host RPC');
    } catch (error) { setStatus(String(error)); }
  }
  useEffect(() => { void read(); }, []);
  async function save() {
    try {
      const committed = await rpc.call('write', text);
      if (committed !== text) throw Error('Readback differs');
      setStatus('Saved and reread via host RPC');
    } catch (error) { setStatus(String(error)); }
  }
  return <section>
    <label>S9 private copy<textarea value={text} onChange={event => setText(event.target.value)} /></label>
    <button onClick={save}>Save private copy</button>
    <button onClick={read}>Reread from disk</button>
    <p role="status">{status}</p>
  </section>;
}

export default definePluginApp(app => {
  app.slots.navPanel({ id: 's9-preview', path: 's9-preview', title: 'S9 Preview', icon: 'File', component: Probe });
  app.slots.fileOpener({id: opener, title: 'S9 private editor', extensions: [], component: Editor});
});
