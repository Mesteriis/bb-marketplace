import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { hostMethods, methods } from './wire.ts';

export default function activate(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({contract: hostMethods});
  async function options() {
    const {primaryHostId} = await bb.sdk.system.config();
    if (!primaryHostId) throw Error('No primary host');
    return {hostId: primaryHostId};
  }
  bb.rpc.register(defineRpcContract(methods), {
    async create() {
      const target = await options();
      return {...target, path: await host.call('create', null, target)};
    },
    async read() {
      return host.call('read', null, await options());
    },
    async write(text) {
      return host.call('write', text, await options());
    },
  });
}
