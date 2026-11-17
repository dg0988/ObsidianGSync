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
 if ('downloadChunks' in drive) for await (const b of (drive as any).downloadChunks(remote, undefined, chunkSize)) output.push(new Uint8Array(b));
 else output.push(new Uint8Array(await drive.download(remote.id)));
 assert.deepEqual(Buffer.concat(output),Buffer.from(bytes)); assert.equal(ranges.length,3);
});
test('a server ignoring Range is rejected',async()=>{
 downloadMock(true); const drive=new DriveClient(async()=> 'fake-token');
 await assert.rejects(async()=>{for await(const _ of (drive as any).downloadChunks(remote, undefined, chunkSize)) {}}, /range/i);
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
  await assert.rejects(async()=>{for await(const _ of new DriveClient(async()=> 'fake').downloadChunks(remote, undefined, chunkSize)){}},/range|changed/i);
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

import { SyncProgress } from '../src/progress';
test('progress reports current bytes, percent and elapsed average speed',()=>{
 let now=0;const p=new SyncProgress(()=>now);p.files(200,375);p.transfer({phase:'download',path:'books/file.pdf',bytes:0,total:4*chunkSize});now=2000;p.transfer({phase:'download',path:'books/file.pdf',bytes:chunkSize,total:4*chunkSize});
 assert.match(p.text(),/200\/375/);assert.match(p.text(),/file.pdf/);assert.match(p.text(),/1.0 \/ 4.0 MiB/);assert.match(p.text(),/25%/);assert.match(p.text(),/0.50 MiB\/s/);
});
test('progress resets speed for a new file and labels local processing',()=>{
 let now=0;const p=new SyncProgress(()=>now);p.transfer({phase:'download',path:'a',bytes:0,total:chunkSize});now=1000;p.transfer({phase:'download',path:'a',bytes:chunkSize,total:chunkSize});
 p.transfer({phase:'upload',path:'b',bytes:0,total:chunkSize});assert.doesNotMatch(p.text(),/1.00 MiB\/s/);p.transfer({phase:'install',path:'b'});assert.match(p.text(),/Saving/);assert.doesNotMatch(p.text(),/MiB\/s/);
});
test('download progress counts bytes consumed by the caller',async()=>{
 downloadMock();const progress:number[]=[];const drive=new DriveClient(async()=> 'fake');
 for await(const _ of drive.downloadChunks(remote,(n)=>progress.push(n),chunkSize)){}
 assert.deepEqual(progress,[0,chunkSize,2*chunkSize,bytes.length]);
});
test('upload progress counts acknowledgements instead of retransmitted bytes',async()=>{
 const progress:number[]=[];let calls=0;
 (globalThis as any).requestUrlMock=async(o:any)=>{
  if(o.url.includes('uploadType='))return response(200,{},undefined,{location:'https://www.googleapis.com/upload/session-test'});
  calls++;
  if(calls<3)return response(308,{},undefined,{range:`bytes=0-${256*1024-1}`});
  return response(200,{...remote,size:String(chunkSize)});
 };
 await new DriveClient(async()=> 'fake').uploadChunks(chunkSize,sourceOf(bytes.slice(0,chunkSize)),{id:'test'},(n)=>progress.push(n));
 assert.deepEqual(progress,[0,256*1024,chunkSize]);
});
test('file progress clears the previous transfer and missing size never displays NaN',()=>{
 const p=new SyncProgress();p.files(1,10);p.transfer({phase:'download',path:'a',bytes:0,total:NaN});assert.doesNotMatch(p.text(),/NaN/);p.files(2,10);assert.doesNotMatch(p.text(),/Downloading/);assert.match(p.text(),/2\/10/);
});

// Configurable transport blocks are independent from local comparison blocks.
import { normalizeTransferChunkSizeMiB, transferChunkBytes } from '../src/transfer-settings';
test('transfer settings accept only the supported sizes and default to 8 MiB', () => {
 for (const n of [1,2,4,8,16]) assert.equal(transferChunkBytes(n),n*chunkSize);
 for (const n of [undefined,null,0,-1,3,32,NaN,Infinity,'4']) {
  assert.equal(normalizeTransferChunkSizeMiB(n),8);assert.equal(transferChunkBytes(n),8*chunkSize);
 }
});
for (const mib of [1,2,4,8,16]) test(`download/upload/read/stage honor ${mib} MiB and final remainders`,async()=>{
 const limit=mib*chunkSize;
 for (const size of [0,17,limit,limit+7]) {
  const data=new Uint8Array(size);for(let i=0;i<size;i++)data[i]=i%251;
  const r={...remote,size:String(size)};let downloaded=0;let uploaded=0;
  (globalThis as any).requestUrlMock=async(o:any)=>{
   if(o.url.includes('uploadType='))return response(200,{},undefined,{location:'https://www.googleapis.com/upload/test'});
   if(o.method==='PUT'){
    if(size===0){assert.equal(o.headers['Content-Range'],'bytes */0');return response(200,r);}
    const end=Math.min(size,uploaded+limit);
    assert.equal(o.headers['Content-Range'],`bytes ${uploaded}-${end-1}/${size}`);
    assert.deepEqual(new Uint8Array(o.body),data.subarray(uploaded,end));uploaded=end;
    return uploaded===size?response(200,r):response(308,{},undefined,{range:`bytes=0-${uploaded-1}`});
   }
   if(!o.url.includes('alt=media'))return response(200,r);
   const end=Math.min(size,downloaded+limit);
   assert.equal(o.headers.Range,`bytes=${downloaded}-${end-1}`);
   const result=response(206,{},data.slice(downloaded,end).buffer,{'content-range':`bytes ${downloaded}-${end-1}/${size}`});downloaded=end;return result;
  };
  const drive=new DriveClient(async()=> 'fake');const {adapter,files}=makeFiles();
  const staged=await files.stage(drive.downloadChunks(r,undefined,limit));
  assert.deepEqual(Buffer.from(adapter.files.get(staged.path)!),Buffer.from(data));assert.equal(downloaded,size);
  assert.equal(adapter.maxAppend,Math.min(limit,size));
  const old=globalThis.fetch;globalThis.fetch=async()=>new Response(data);
  try{await drive.uploadChunks(size,files.readChunks(staged.path,limit),{id:r.id},undefined,limit);}finally{globalThis.fetch=old;}
  assert.equal(uploaded,size);await staged.dispose();
 }
});
test('large upload reuses original buffer then resends only the unacknowledged suffix',async()=>{
 const data=new Uint8Array(8*chunkSize);data.fill(123);let call=0;const progress:number[]=[];
 (globalThis as any).requestUrlMock=async(o:any)=>{
  if(o.url.includes('uploadType='))return response(200,{},undefined,{location:'https://www.googleapis.com/upload/test'});
  call++;
  if(call===1){assert.equal(o.body,data.buffer);throw new Error('lost response');}
  if(call===2){assert.equal(o.headers['Content-Range'],`bytes */${data.length}`);return response(308,{},undefined,{range:`bytes=0-${2*chunkSize-1}`});}
  assert.equal(o.headers['Content-Range'],`bytes ${2*chunkSize}-${data.length-1}/${data.length}`);
  assert.deepEqual(new Uint8Array(o.body),data.subarray(2*chunkSize));return response(200,{...remote,size:String(data.length)});
 };
 async function* input(){yield data.buffer;}
 await new DriveClient(async()=> 'fake').uploadChunks(data.length,input(),{id:'test'},n=>progress.push(n));
 assert.equal(call,3);assert.deepEqual(progress,[0,2*chunkSize,data.length]);
});
test('staging rejects chunks above the absolute 16 MiB ceiling',async()=>{
 const {files}=makeFiles();async function* input(){yield new ArrayBuffer(16*chunkSize+1);}
 await assert.rejects(()=>files.stage(input()),/Oversized/);
});
test('sync snapshots the selected upload size while settings change mid-transfer',async()=>{
 const f=await syncFixture(bytes);const selected={...settings,transferChunkSizeMiB:2};const state:any={'note.bin':{remoteId:'test',remoteRev:remote.md5Checksum,localMtime:0,localSize:0}};
 const sizes:number[]=[];
 (f.drive as any).uploadChunks=async(size:number,chunks:any,target:any,progress:any,limit:number)=>{
  assert.equal(limit,2*chunkSize);selected.transferChunkSizeMiB=16;
  for await(const block of chunks)sizes.push(block.byteLength);
  return {...remote,size:String(size)};
 };
 try{const result=await runSync({vault:f.vault} as any,f.drive as any,selected,state,hooks);assert.deepEqual(result.errors,[]);assert.deepEqual(sizes,[2*chunkSize,7]);}finally{f.restore();}
});
test('sync passes the selected download limit to Drive',async()=>{
 const f=await syncFixture();let limit=0;const original=f.drive.downloadChunks;
 (f.drive as any).downloadChunks=(r:any,p:any,n:number)=>{limit=n;return original();};
 try{const result=await runSync({vault:f.vault} as any,f.drive as any,{...settings,transferChunkSizeMiB:4},{},hooks);assert.deepEqual(result.errors,[]);assert.equal(limit,4*chunkSize);}finally{f.restore();}
});
test('unsupported byte limits are rejected before opening requests or local streams',async()=>{
 const drive=new DriveClient(async()=>{throw new Error('should not request');});const {files}=makeFiles();
 for(const limit of [0,3*chunkSize,32*chunkSize]){
  await assert.rejects(async()=>{for await(const _ of drive.downloadChunks(remote,undefined,limit)){}},/Unsupported/);
  await assert.rejects(()=>drive.uploadChunks(0,sourceOf(new Uint8Array()),{id:'test'},undefined,limit),/Unsupported/);
  await assert.rejects(async()=>{for await(const _ of files.readChunks('missing',limit)){}},/Unsupported/);
 }
});

import { createHash } from 'node:crypto';
import { Platform } from 'obsidian';
const sha256Of=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
async function checksumFixture(data=bytes,checksum:unknown=sha256Of(data)){
 const f=await syncFixture(data);const tree=await f.drive.listTree();const r:any=tree.files.get('note.bin')!;
 r.size=String(data.length);r.sha256Checksum=checksum;
 f.drive.listTree=async()=>tree;
 let downloads=0,metadata=0,reads=0;
 const original=f.drive.downloadChunks;
 f.drive.downloadChunks=()=>{downloads++;return original();};
 (f.drive as any).getFile=async()=>{metadata++;return {...r};};
 const oldFetch=globalThis.fetch;globalThis.fetch=async(...args:Parameters<typeof fetch>)=>{reads++;return oldFetch(...args);};
 return {...f,r,counts:()=>({downloads,metadata,reads})};
}
for(const android of [true,false])test(`SHA match skips cloud contents on ${android?'Android':'desktop/iOS'} without state migration`,async()=>{
 const f=await checksumFixture();const state:any={};const phases:string[]=[];Platform.isAndroidApp=android;
 try{
  const result=await runSync({vault:f.vault} as any,f.drive as any,settings,state,{...hooks,transfer:p=>phases.push(p.phase)});
  assert.deepEqual(result.errors,[]);assert.deepEqual(result.conflicts,[]);assert.equal(f.counts().downloads,0);assert.equal(f.counts().metadata,1);
  assert.deepEqual(state['note.bin'],{remoteId:'test',remoteRev:remote.md5Checksum,localMtime:(await f.adapter.stat('note.bin'))!.mtime,localSize:bytes.length});
  assert.ok(phases.includes('hash'));assert.equal(f.uploaded.length,0);
 }finally{Platform.isAndroidApp=true;f.restore();}
});
test('empty files and SHA known vector compare without downloading',async()=>{
 for(const data of [new Uint8Array(),new TextEncoder().encode('abc')]){
  const f=await checksumFixture(data);const state:any={};
  try{const result=await runSync({vault:f.vault} as any,f.drive as any,settings,state,hooks);assert.deepEqual(result.errors,[]);assert.equal(f.counts().downloads,0);assert.equal(state['note.bin'].localSize,data.length);}finally{f.restore();}
 }
});
test('SHA mismatch preserves both versions without an extra byte comparison',async()=>{
 const local=bytes.slice();local[0]^=255;const f=await checksumFixture(local,sha256Of(bytes));
 const read=globalThis.fetch;globalThis.fetch=async(url:any,options:any)=>{assert.ok(!String(url).includes('/transfers/'),'must not read staged contents for comparison');return read(url,options);};
 // Conflict upload legitimately reads staging only after installation to a visible path.
 try{const result=await runSync({vault:f.vault} as any,f.drive as any,settings,{},hooks);assert.deepEqual(result.errors,[]);assert.deepEqual(result.conflicts,['note.bin']);assert.equal(f.counts().downloads,1);assert.deepEqual(f.uploaded.map(v=>v.bytes),[Buffer.from(bytes),Buffer.from(local)]);}finally{f.restore();}
});
test('different sizes skip hashing and byte comparison but preserve the remote conflict',async()=>{
 const f=await checksumFixture(new Uint8Array([1,2,3]),sha256Of(bytes));f.r.size=String(bytes.length);const phases:string[]=[];
 try{const result=await runSync({vault:f.vault} as any,f.drive as any,settings,{}, {...hooks,transfer:p=>phases.push(p.phase)});assert.deepEqual(result.errors,[]);assert.deepEqual(result.conflicts,['note.bin']);assert.ok(!phases.includes('hash'));assert.ok(!phases.includes('compare'));assert.equal(f.counts().metadata,0);}finally{f.restore();}
});
test('missing or malformed SHA falls back to existing exact comparison',async()=>{
 for(const checksum of [undefined,null,'','a'.repeat(63),'z'.repeat(64),123]){
  const f=await checksumFixture(bytes,checksum);f.r.sha256Checksum=checksum;const state:any={};
  try{const result=await runSync({vault:f.vault} as any,f.drive as any,settings,state,hooks);assert.deepEqual(result.errors,[]);assert.equal(f.counts().downloads,1);assert.equal(f.counts().metadata,0);assert.equal(f.uploaded.length,0);assert.ok(state['note.bin']);}finally{f.restore();}
 }
});
test('unchanged tracked files skip both hashing and media requests',async()=>{
 const f=await checksumFixture();const stat=await f.adapter.stat('note.bin');const state:any={'note.bin':{remoteId:'test',remoteRev:remote.md5Checksum,localMtime:stat!.mtime,localSize:stat!.size}};
 try{const result=await runSync({vault:f.vault} as any,f.drive as any,settings,state,hooks);assert.deepEqual(result.errors,[]);assert.deepEqual(f.counts(),{downloads:0,metadata:0,reads:0});}finally{f.restore();}
});
test('simultaneous changes with identical SHA update the existing record without a conflict',async()=>{
 const f=await checksumFixture();const state:any={'note.bin':{remoteId:'test',remoteRev:'old-revision',localMtime:0,localSize:0}};
 try{const result=await runSync({vault:f.vault} as any,f.drive as any,settings,state,hooks);assert.deepEqual(result.errors,[]);assert.deepEqual(result.conflicts,[]);assert.equal(f.counts().downloads,0);assert.equal(state['note.bin'].remoteRev,remote.md5Checksum);}finally{f.restore();}
});
test('a remote revision change during hashing prevents recording state',async()=>{
 for(const change of [{version:'2'},{sha256Checksum:'0'.repeat(64)},{size:'1'},{modifiedTime:'new'}]){
  const f=await checksumFixture();const state:any={};(f.drive as any).getFile=async()=>({...f.r,...change});
  try{const result=await runSync({vault:f.vault} as any,f.drive as any,settings,state,hooks);assert.match(result.errors.join(),/Remote file changed/);assert.deepEqual(state,{});assert.equal(f.uploaded.length,0);}finally{f.restore();}
 }
});
test('a local edit while reading or validating the remote checksum prevents recording state',async()=>{
 for(const when of ['read','remote','record']){
  const f=await checksumFixture();const state:any={};
  if(when==='read'){
   const fetch=globalThis.fetch;globalThis.fetch=async(...args:Parameters<typeof fetch>)=>{const r=await fetch(...args);await f.adapter.write('note.bin','edited');return r;};
  }else (f.drive as any).getFile=async()=>{
   if(when==='remote')await f.adapter.write('note.bin','edited');
   else {const stat=f.adapter.stat.bind(f.adapter);let calls=0;f.adapter.stat=async(p)=>{if(p==='note.bin'&&++calls===2)await f.adapter.write(p,'edited');return stat(p);};}
   return {...f.r};
  };
  try{const result=await runSync({vault:f.vault} as any,f.drive as any,settings,state,hooks);assert.match(result.errors.join(),/Local file changed/);assert.deepEqual(state,{});assert.equal(f.uploaded.length,0);}finally{f.restore();}
 }
});
test('Drive requests SHA metadata in listings and fresh file metadata',async()=>{
 (globalThis as any).requestUrlMock=async(o:any)=>{assert.ok(new URL(o.url).searchParams.get('fields')!.includes('sha256Checksum'));return response(200,o.url.includes('/files?')?{files:[]}:{...remote,sha256Checksum:sha256Of(bytes)});};
 const drive=new DriveClient(async()=> 'fake');await drive.listChildren('root');assert.equal((await drive.getFile('test')).sha256Checksum,sha256Of(bytes));
});
test('hashing progress has a separate label and byte percentage',()=>{
 const progress=new SyncProgress();progress.transfer({phase:'hash',path:'a.pdf',bytes:chunkSize,total:2*chunkSize});assert.match(progress.text(),/Hashing/);assert.match(progress.text(),/50%/);
});
import { hashLocalFile } from '../src/checksum';
test('hashing stays at 1 MiB regardless of the transport ceiling and handles stream boundaries',async()=>{
 const {adapter}=makeFiles();await adapter.writeBinary('note.bin',bytes.buffer);const old=globalThis.fetch;const progress:number[]=[];
 globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,19));c.enqueue(bytes.subarray(19,chunkSize+43));c.enqueue(bytes.subarray(chunkSize+43));c.close();}}));
 try{assert.equal(await hashLocalFile(adapter as any,'note.bin',n=>progress.push(n)),sha256Of(bytes));assert.deepEqual(progress,[0,chunkSize,2*chunkSize,bytes.length]);}finally{globalThis.fetch=old;}
});
test('hashing accepts uppercase SHA metadata',async()=>{
 const f=await checksumFixture(bytes,sha256Of(bytes).toUpperCase());
 try{const result=await runSync({vault:f.vault} as any,f.drive as any,settings,{},hooks);assert.deepEqual(result.errors,[]);assert.equal(f.counts().downloads,0);}finally{f.restore();}
});
test('failed local streams or remote validation never mark a checksum comparison complete',async()=>{
 for(const mode of ['truncated','unreadable','metadata-error']){
  const f=await checksumFixture();const state:any={};
  if(mode==='truncated')globalThis.fetch=async()=>new Response(bytes.subarray(0,100));
  if(mode==='unreadable')globalThis.fetch=async()=>new Response(null,{status:404});
  if(mode==='metadata-error')(f.drive as any).getFile=async()=>{throw new Error('offline');};
  try{const result=await runSync({vault:f.vault} as any,f.drive as any,settings,state,hooks);assert.equal(result.errors.length,1);assert.deepEqual(state,{});assert.equal(f.counts().downloads,0);assert.equal(f.uploaded.length,0);}finally{f.restore();}
 }
});
test('matching checksums at different relative paths are not treated as the same file',async()=>{
 const f=await checksumFixture();const tree=await f.drive.listTree();tree.files.delete('note.bin');tree.files.set('other.bin',{...f.r,name:'other.bin'});const state:any={};const phases:string[]=[];
 try{const result=await runSync({vault:f.vault} as any,f.drive as any,settings,state,{...hooks,transfer:p=>phases.push(p.phase)});assert.deepEqual(result.errors,[]);assert.equal(result.uploaded,1);assert.equal(result.downloaded,1);assert.equal(f.counts().metadata,0);assert.ok(!phases.includes('hash'));assert.deepEqual(Object.keys(state).sort(),['note.bin','other.bin']);}finally{f.restore();}
});
test('desktop/iOS keep the byte-comparison fallback without a SHA checksum',async()=>{
 const f=await checksumFixture();delete f.r.sha256Checksum;Platform.isAndroidApp=false;
 (f.vault as any).readBinary=async()=>bytes.slice().buffer;(f.drive as any).download=async()=>bytes.slice().buffer;const state:any={};
 try{const result=await runSync({vault:f.vault} as any,f.drive as any,settings,state,hooks);assert.deepEqual(result.errors,[]);assert.ok(state['note.bin']);assert.equal(f.counts().reads,0);}finally{Platform.isAndroidApp=true;f.restore();}
});
test('desktop checksum mismatch still preserves both local and remote versions',async()=>{
 const local=bytes.slice();local[0]^=255;const f=await checksumFixture(local,sha256Of(bytes));Platform.isAndroidApp=false;
 const original=f.vault.getAbstractFileByPath();
 (f.vault as any).getAbstractFileByPath=(path:string)=>path==='note.bin'?original:null;
 (f.vault as any).readBinary=async()=>local.slice().buffer;
 (f.vault as any).createBinary=async(path:string,data:ArrayBuffer)=>f.adapter.writeBinary(path,data);
 (f.drive as any).download=async()=>bytes.slice().buffer;
 (f.drive as any).createFile=async(name:string,parentId:string,data:ArrayBuffer)=>{f.uploaded.push({target:{name,parentId},bytes:Buffer.from(data)});return {...f.r,id:'conflict-id'};};
 (f.drive as any).updateFile=async(id:string,data:ArrayBuffer)=>{f.uploaded.push({target:{id},bytes:Buffer.from(data)});return {...f.r};};
 try{
  const result=await runSync({vault:f.vault} as any,f.drive as any,settings,{},hooks);
  assert.deepEqual(result.errors,[]);assert.deepEqual(result.conflicts,['note.bin']);
  assert.deepEqual(f.uploaded.map(v=>v.bytes),[Buffer.from(bytes),Buffer.from(local)]);
  assert.deepEqual(f.adapter.files.get('note.bin'),local);
  const conflict=[...f.adapter.files.keys()].find(p=>p.includes('(conflict'))!;
  assert.deepEqual(f.adapter.files.get(conflict),bytes);
 }finally{Platform.isAndroidApp=true;f.restore();}
});
