import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DriveClient } from '../src/drive';
const chunkSize = 1024 * 1024;
const remote = { id: 'test', name: 'large.bin', mimeType: 'application/octet-stream', size: String(chunkSize * 2 + 7), md5Checksum: 'test-md5', modifiedTime: 'time', version: '1' };
const bytes = new Uint8Array(Number(remote.size));
for (let i=0;i<bytes.length;i++) bytes[i]=i%251;
const response = (status: number, json: any = {}, data = new ArrayBuffer(0), headers = {}) => ({status,json,arrayBuffer:data,headers,text:''});
function downloadMock(breakRange = false) {
 const ranges: string[]=[];
 (globalThis as any).requestUrlMock = async (o: any) => {
  if (!o.url.includes('alt=media')) return response(200, remote);
  assert.ok(o.headers.Range, 'binary responses must be bounded with Range');
  const m=/bytes=(\d+)-(\d+)/.exec(o.headers.Range)!;
  const start=Number(m[1]), end=Number(m[2]); ranges.push(o.headers.Range);
  assert.ok(end-start+1<=chunkSize);
  return response(breakRange?200:206,{},bytes.slice(start,end+1).buffer, {'content-range':`bytes ${start}-${end}/${bytes.length}`});
 };
 return ranges;
}
test('Android download bounds every media response and preserves bytes', async () => {
 const ranges=downloadMock(); const drive=new DriveClient(async()=> 'fake-token');
 // The baseline full download must fail at the HTTP boundary.
 const output: Uint8Array[]=[];
 if ('downloadChunks' in drive) for await (const b of (drive as any).downloadChunks(remote)) output.push(new Uint8Array(b));
 else output.push(new Uint8Array(await drive.download(remote.id)));
 assert.deepEqual(Buffer.concat(output),Buffer.from(bytes)); assert.equal(ranges.length,3);
});
test('a server ignoring Range is rejected',async()=>{
 downloadMock(true); const drive=new DriveClient(async()=> 'fake-token');
 await assert.rejects(async()=>{for await(const _ of (drive as any).downloadChunks(remote)) {}}, /range/i);
});

test('resumable upload recovers a lost acknowledgement without duplicating bytes', async()=>{
 const received: Uint8Array[]=[]; let stored=0; let lost=false;
 (globalThis as any).requestUrlMock=async(o:any)=>{
  if(o.url.includes('uploadType=resumable')) return response(200,{},undefined,{location:'https://www.googleapis.com/upload/session-test'});
  const range=o.headers['Content-Range'];
  if(range.startsWith('bytes */')) return response(308,{},undefined,{range:`bytes=0-${stored-1}`});
  const match=/bytes (\d+)-(\d+)\/(\d+)/.exec(range)!;
  assert.equal(Number(match[1]),stored); assert.ok(o.body.byteLength<=chunkSize);
  received.push(new Uint8Array(o.body));stored+=o.body.byteLength;
  if(!lost){lost=true;throw new Error('connection lost after server stored chunk');}
  return stored===bytes.length?response(200,remote):response(308,{},undefined,{range:`bytes=0-${stored-1}`});
 };
 async function* source(){for(let i=0;i<bytes.length;i+=chunkSize)yield bytes.slice(i,i+chunkSize).buffer;}
 const result=await new DriveClient(async()=> 'fake-token').uploadChunks(bytes.length,source(),{id:'test'});
 assert.equal(result.id,'test');assert.deepEqual(Buffer.concat(received),Buffer.from(bytes));
});

import { AndroidFiles } from '../src/android-files';
class MemoryAdapter {
 files=new Map<string,Uint8Array>(); dirs=new Set<string>(); clock=1; times=new Map<string,number>(); maxAppend=0;
 failRenameTo='';
 async exists(p:string){return this.files.has(p)||this.dirs.has(p);}
 async mkdir(p:string){this.dirs.add(p);}
 async stat(p:string){const b=this.files.get(p);return b?{type:'file',size:b.length,mtime:this.times.get(p)??1,ctime:1}:null;}
 async writeBinary(p:string,b:ArrayBuffer){this.files.set(p,new Uint8Array(b).slice());this.times.set(p,++this.clock);}
 async appendBinary(p:string,b:ArrayBuffer){this.maxAppend=Math.max(this.maxAppend,b.byteLength);const old=this.files.get(p)!;this.files.set(p,Buffer.concat([old,new Uint8Array(b)]));}
 async write(p:string,s:string){await this.writeBinary(p,new TextEncoder().encode(s).buffer);}
 async read(p:string){return new TextDecoder().decode(this.files.get(p));}
 async rename(a:string,b:string){if(b===this.failRenameTo)throw new Error('rename failure');assert.ok(!this.files.has(b));this.files.set(b,this.files.get(a)!);this.files.delete(a);this.times.set(b,++this.clock);}
 async copy(a:string,b:string){await this.writeBinary(b,Uint8Array.from(this.files.get(a)!).buffer);}
 async remove(p:string){this.files.delete(p);}
 async rmdir(p:string){for(const f of this.files.keys())if(f.startsWith(p+'/'))this.files.delete(f);this.dirs.delete(p);}
 async list(p:string){return {folders:[...this.dirs].filter(d=>d.startsWith(p+'/')&&!d.slice(p.length+1).includes('/')),files:[...this.files.keys()].filter(f=>f.startsWith(p+'/'))};}
 getResourcePath(p:string){return 'https://local.invalid/'+p;}
}
const makeFiles=()=>{const adapter=new MemoryAdapter();return {adapter,files:new AndroidFiles(adapter as any,'.obsidian')};};
async function* sourceOf(b:Uint8Array){for(let i=0;i<b.length;i+=chunkSize)yield b.slice(i,i+chunkSize).buffer;}
test('interrupted staged download leaves the original untouched',async()=>{
 const {adapter,files}=makeFiles();await adapter.write('note.bin','original');
 async function* broken(){yield new ArrayBuffer(10);throw new Error('network');}
 await assert.rejects(()=>files.stage(broken()),/network/);
 assert.equal(await adapter.read('note.bin'),'original');assert.equal(adapter.files.size,1);
});
test('staged install uses bounded appends and replaces only the expected original',async()=>{
 const {adapter,files}=makeFiles();await adapter.write('note.bin','original');const stat=await adapter.stat('note.bin');
 const staged=await files.stage(sourceOf(bytes));await staged.install('note.bin',stat);
 assert.ok(Buffer.from(adapter.files.get('note.bin')!).equals(Buffer.from(bytes)));assert.ok(adapter.maxAppend<=chunkSize);assert.equal(adapter.files.size,1);
});
test('editing the destination while downloading prevents replacement',async()=>{
 const {adapter,files}=makeFiles();await adapter.write('note.bin','original');const stat=await adapter.stat('note.bin');
 const staged=await files.stage(sourceOf(bytes));await adapter.write('note.bin','edited');
 await assert.rejects(()=>staged.install('note.bin',stat),/changed/);await staged.dispose();
 assert.equal(await adapter.read('note.bin'),'edited');
});
test('local stream rechunks bytes without readBinary',async()=>{
 const {adapter,files}=makeFiles();await adapter.writeBinary('note.bin',bytes.buffer);
 const old=globalThis.fetch;
 globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,300));c.enqueue(bytes.subarray(300,chunkSize+500));c.enqueue(bytes.subarray(chunkSize+500));c.close();}}));
 try {const out=[];for await(const b of files.readChunks('note.bin')){assert.ok(b.byteLength<=chunkSize);out.push(new Uint8Array(b));}assert.deepEqual(Buffer.concat(out),Buffer.from(bytes));}finally{globalThis.fetch=old;}
});

test('disposing a successfully installed stage is idempotent',async()=>{
 const {adapter,files}=makeFiles();const originalRmdir=adapter.rmdir.bind(adapter);
 adapter.rmdir=async(p:string)=>{if(!adapter.dirs.has(p))throw new Error('ENOENT');await originalRmdir(p);};
 const staged=await files.stage(sourceOf(new Uint8Array([1])));await staged.install('new.bin',null);
 await staged.dispose();await staged.dispose();
});
test('recovery restores original after an interrupted replacement',async()=>{
 const {adapter,files}=makeFiles();const dir='.obsidian/plugins/gsync/transfers/transfer-test';await adapter.mkdir('.obsidian/plugins/gsync/transfers');await adapter.mkdir(dir);
 await adapter.write(dir+'/journal.json',JSON.stringify({target:'note.bin',hadOriginal:true}));await adapter.write(dir+'/original','original');await adapter.write(dir+'/data','replacement');
 await files.recover();assert.equal(await adapter.read('note.bin'),'original');assert.ok(await adapter.exists(dir+'/original'));
});
test('recovery preserves both copies if replacement finished before cleanup',async()=>{
 const {adapter,files}=makeFiles();const dir='.obsidian/plugins/gsync/transfers/transfer-test';await adapter.mkdir('.obsidian/plugins/gsync/transfers');await adapter.mkdir(dir);
 await adapter.write(dir+'/journal.json',JSON.stringify({target:'note.bin',hadOriginal:true}));await adapter.write(dir+'/original','original');await adapter.write('note.bin','replacement');
 assert.equal((await files.recover()).length,1);await files.recover();
 assert.equal(await adapter.read('note.bin'),'original');assert.equal(await adapter.read(dir+'/retained-target'),'replacement');
});
test('incomplete or mismatched ranges fail instead of saving corrupted data',async()=>{
 for(const mode of ['truncated','wrong-offset','changed-version']){
  downloadMock(); const base=(globalThis as any).requestUrlMock;let metadata=0;
  (globalThis as any).requestUrlMock=async(o:any)=>{
   const r=await base(o);
   if(o.url.includes('alt=media')){
    if(mode==='truncated')r.arrayBuffer=r.arrayBuffer.slice(1);
    if(mode==='wrong-offset')r.headers['content-range']='bytes 1-2/3';
   }else if(++metadata>1 && mode==='changed-version')r.json={...remote,version:'2'};
   return r;
  };
  await assert.rejects(async()=>{for await(const _ of new DriveClient(async()=> 'fake').downloadChunks(remote)){}},/range|changed/i);
 }
});

import { runSync } from '../src/sync';
import { TFile } from 'obsidian';
async function syncFixture(initial?: Uint8Array) {
 const {adapter,files}=makeFiles(); if(initial)await adapter.writeBinary('note.bin',initial.slice().buffer);
 const local=initial?Object.assign(new TFile(),{path:'note.bin',stat:await adapter.stat('note.bin')}):null;
 const vault={adapter,configDir:'.obsidian',getFiles:()=>local?[local]:[],getAbstractFileByPath:()=>local,
  readBinary:()=>{throw new Error('whole file read forbidden on Android');},createBinary:()=>{throw new Error('whole file write forbidden on Android');}};
 const r={...remote,name:'note.bin',size:String(bytes.length)};const uploaded:{target:any,bytes:Buffer}[]=[];
 const drive={ensureFolderPath:async()=> 'root',listTree:async()=>({files:new Map([['note.bin',r]]),folders:new Map([['','root']]),warnings:[]}),
  downloadChunks:()=>sourceOf(bytes),uploadChunks:async(size:number,chunks:any,target:any)=>{const out=[];for await(const c of chunks)out.push(new Uint8Array(c));const b=Buffer.concat(out);assert.equal(b.length,size);uploaded.push({target,bytes:b});return {...r,id:target.id??'conflict-id',size:String(size)};}};
 const old=globalThis.fetch;globalThis.fetch=async(url:any)=>{
  const p=String(url).replace('https://local.invalid/','');const data=adapter.files.get(p);return data?new Response(data.slice()):new Response(null,{status:404});
 };
 return {adapter,files,vault,drive,uploaded,restore:()=>{globalThis.fetch=old;}};
}
const settings={remoteFolder:'root',maxFileSizeMB:0,excludes:'',propagateDeletes:false} as any;
const hooks={checkpoint:async()=>{},progress:()=>{}};
test('first sync with identical existing copy compares streams and records state',async()=>{
 const f=await syncFixture(bytes);const state:any={};
 try{const result=await runSync({vault:f.vault} as any,f.drive as any,settings,state,hooks);assert.deepEqual(result.errors,[]);assert.equal(f.uploaded.length,0);assert.equal(state['note.bin'].remoteId,'test');assert.equal(f.adapter.files.size,1);}finally{f.restore();}
});
test('initial download installs bytes and records only complete transfer',async()=>{
 const f=await syncFixture();const state:any={};
 try{const result=await runSync({vault:f.vault} as any,f.drive as any,settings,state,hooks);assert.deepEqual(result.errors,[]);assert.equal(result.downloaded,1);assert.ok(Buffer.from(f.adapter.files.get('note.bin')!).equals(Buffer.from(bytes)));assert.equal(state['note.bin'].localSize,bytes.length);}finally{f.restore();}
});
test('failed download neither records state nor exposes partial file',async()=>{
 const f=await syncFixture();const state:any={};f.drive.downloadChunks=async function*(){yield new ArrayBuffer(100);throw new Error('offline');};
 try{const result=await runSync({vault:f.vault} as any,f.drive as any,settings,state,hooks);assert.equal(result.errors.length,1);assert.deepEqual(state,{});assert.equal(await f.adapter.exists('note.bin'),false);}finally{f.restore();}
});
test('conflict keeps local original and uploads separate remote copy',async()=>{
 const local=new Uint8Array([1,2,3]);const f=await syncFixture(local);const state:any={};
 try{const result=await runSync({vault:f.vault} as any,f.drive as any,settings,state,hooks);assert.deepEqual(result.errors,[]);assert.deepEqual(result.conflicts,['note.bin']);assert.equal(f.uploaded.length,2);assert.ok(f.uploaded[0].bytes.equals(Buffer.from(bytes)));assert.ok(f.uploaded[1].bytes.equals(Buffer.from(local)));assert.ok(Buffer.from(f.adapter.files.get('note.bin')!).equals(Buffer.from(local)));assert.equal(Object.keys(state).length,2);}finally{f.restore();}
});

test('upload sends only the unacknowledged suffix after a partial acknowledgement',async()=>{
 const data=bytes.slice(0,chunkSize);let requests=0;
 (globalThis as any).requestUrlMock=async(o:any)=>{
  if(o.url.includes('uploadType='))return response(200,{},undefined,{location:'https://www.googleapis.com/upload/session-test'});
  requests++;
  if(requests===1)return response(308,{},undefined,{Range:`bytes=0-${256*1024-1}`});
  assert.equal(o.headers['Content-Range'],`bytes ${256*1024}-${chunkSize-1}/${chunkSize}`);
  assert.ok(Buffer.from(o.body).equals(Buffer.from(data.subarray(256*1024))));
  return response(200,{...remote,size:String(chunkSize)});
 };
 await new DriveClient(async()=> 'fake').uploadChunks(chunkSize,sourceOf(data),{id:'test'});assert.equal(requests,2);
});
test('empty files have no range download and finalize a zero-byte upload',async()=>{
 let media=0;let upload=0;
 (globalThis as any).requestUrlMock=async(o:any)=>{
  if(o.url.includes('uploadType='))return response(200,{},undefined,{location:'https://www.googleapis.com/upload/session-test'});
  if(o.method==='PUT'){upload++;assert.equal(o.headers['Content-Range'],'bytes */0');return response(200,{...remote,size:'0'});}
  if(o.url.includes('alt=media'))media++;
  return response(200,{...remote,size:'0'});
 };
 const drive=new DriveClient(async()=> 'fake');for await(const _ of drive.downloadChunks({...remote,size:'0'}))assert.fail('empty download yielded bytes');
 await drive.uploadChunks(0,sourceOf(new Uint8Array(0)),{id:'test'});assert.equal(media,0);assert.equal(upload,1);
});
test('local change is detected before yielding the final upload block',async()=>{
 const {adapter,files}=makeFiles();await adapter.writeBinary('note.bin',new Uint8Array([1,2,3]).buffer);const old=globalThis.fetch;
 globalThis.fetch=async()=>{await adapter.write('note.bin','changed');return new Response(new Uint8Array([1,2,3]));};
 let yielded=0;try{await assert.rejects(async()=>{for await(const _ of files.readChunks('note.bin'))yielded++;},/changed/);assert.equal(yielded,0);}finally{globalThis.fetch=old;}
});
test('upload failure does not record a successful local update',async()=>{
 const f=await syncFixture(new Uint8Array([1,2,3]));const state:any={'note.bin':{remoteId:'test',remoteRev:remote.md5Checksum,localMtime:0,localSize:3}};const before=JSON.stringify(state);
 f.drive.uploadChunks=async()=>{throw new Error('offline');};
 try{const r=await runSync({vault:f.vault} as any,f.drive as any,settings,state,hooks);assert.equal(r.errors.length,1);assert.equal(r.uploaded,0);assert.equal(JSON.stringify(state),before);}finally{f.restore();}
});

test('malformed journal is preserved and does not prevent other recovery',async()=>{
 const {adapter,files}=makeFiles();const root='.obsidian/plugins/gsync/transfers';const dir=root+'/transfer-bad';await adapter.mkdir(root);await adapter.mkdir(dir);await adapter.write(dir+'/journal.json','{');await adapter.write(dir+'/original','saved');
 const warnings=await files.recover();assert.equal(warnings.length,1);assert.equal(await adapter.read(dir+'/original'),'saved');
});
test('install does not rename visible files and copy refreshes the vault index',async()=>{
 const {adapter,files}=makeFiles();const cache=new Set<string>();const oldCopy=adapter.copy.bind(adapter);const oldRename=adapter.rename.bind(adapter);
 adapter.copy=async(a,b)=>{await oldCopy(a,b);if(!b.startsWith('.'))cache.add(b);};
 adapter.rename=async(a,b)=>{assert.ok(a.startsWith('.')&&b.startsWith('.'),'visible file must not be renamed');await oldRename(a,b);};
 await adapter.write('note.bin','old');cache.add('note.bin');const before=await adapter.stat('note.bin');
 const staged=await files.stage(sourceOf(new Uint8Array([5,6])));await staged.install('note.bin',before);assert.ok(cache.has('note.bin'));
 const staged2=await files.stage(sourceOf(new Uint8Array([7])));await staged2.install('new.bin',null);assert.ok(cache.has('new.bin'));
});
test('failed native install retains backup and recovery restores the original',async()=>{
 const {adapter,files}=makeFiles();await adapter.write('note.bin','original');const before=await adapter.stat('note.bin');
 const staged=await files.stage(sourceOf(new Uint8Array([1,2,3])));const oldCopy=adapter.copy.bind(adapter);
 adapter.copy=async(a,b)=>{if(b==='note.bin'){await adapter.write(b,'partial');throw new Error('disk failure');}await oldCopy(a,b);};
 await assert.rejects(()=>staged.install('note.bin',before),/disk failure/);await staged.dispose();
 adapter.copy=oldCopy;assert.equal((await files.recover()).length,1);assert.equal(await adapter.read('note.bin'),'original');
});

test('recovery preserves edits made between failed attempts',async()=>{
 const {adapter,files}=makeFiles();const root='.obsidian/plugins/gsync/transfers';const dir=root+'/transfer-repeat';await adapter.mkdir(root);await adapter.mkdir(dir);
 await adapter.write(dir+'/journal.json',JSON.stringify({target:'note.bin',hadOriginal:true}));await adapter.write(dir+'/original','original');await adapter.write('note.bin','first edit');
 const copy=adapter.copy.bind(adapter);adapter.copy=async(a,b)=>{if(a.endsWith('/original'))throw new Error('cannot restore yet');await copy(a,b);};
 await files.recover();assert.ok(files.blockedPaths.has('note.bin'));await adapter.write('note.bin','second edit');adapter.copy=copy;await files.recover();
 const retained=await Promise.all([...adapter.files.keys()].filter(p=>p.includes('/retained-target')).map(p=>adapter.read(p)));
 assert.ok(retained.includes('first edit'));assert.ok(retained.includes('second edit'));assert.equal(await adapter.read('note.bin'),'original');assert.ok(!files.blockedPaths.has('note.bin'));
});
test('short recovery copy keeps journal and blocks syncing the affected target',async()=>{
 const {adapter,files}=makeFiles();const root='.obsidian/plugins/gsync/transfers';const dir=root+'/transfer-short';await adapter.mkdir(root);await adapter.mkdir(dir);
 await adapter.write(dir+'/journal.json',JSON.stringify({target:'note.bin',hadOriginal:true}));await adapter.write(dir+'/original','original');await adapter.write('note.bin','partial');
 const copy=adapter.copy.bind(adapter);adapter.copy=async(a,b)=>{if(a.endsWith('/original'))await adapter.write(b,'x');else await copy(a,b);};
 await files.recover();assert.ok(await adapter.exists(dir+'/journal.json'));assert.ok(files.blockedPaths.has('note.bin'));assert.equal(await adapter.read(dir+'/original'),'original');assert.equal(await adapter.read(dir+'/retained-target'),'partial');
});
