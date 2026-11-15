import {defineRpcContract,type BbPluginApi} from '@get-bb/plugin-sdk';
import {z} from 'zod';
import {createLayoutStore} from './src/adapters/bb/layout-store';
import {decodeDocument} from './src/core/document';
const documentSchema=z.unknown().transform((v,ctx)=>{const r=decodeDocument(v);if(r.kind!=='valid'){ctx.addIssue({code:'custom',message:'Невалидная раскладка'});return z.NEVER;}return r.document;});
export const contract=defineRpcContract({read:{input:z.null(),output:z.unknown()},save:{input:z.object({document:documentSchema,expectedRevision:z.number().int().nonnegative()}),output:z.unknown()}});
export default function plugin(bb:BbPluginApi){const store=createLayoutStore(bb.storage.database());bb.rpc.register(contract,{read:()=>store.read(),save:({document,expectedRevision})=>{const r=store.save(document,expectedRevision);if(r.kind==='saved')bb.realtime.publish('layout-changed',{revision:r.document.revision});return r;}});}
