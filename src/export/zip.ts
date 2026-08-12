export interface ZipEntry { name:string; data:Uint8Array|string }

const encoder=new TextEncoder()
const crcTable=(()=>{const table=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0}return table})()
function crc32(bytes:Uint8Array){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&0xff]!^(crc>>>8);return(crc^0xffffffff)>>>0}
function u16(view:DataView,offset:number,value:number){view.setUint16(offset,value,true)}
function u32(view:DataView,offset:number,value:number){view.setUint32(offset,value,true)}
function concat(parts:Uint8Array[]){const length=parts.reduce((sum,p)=>sum+p.length,0),out=new Uint8Array(length);let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length}return out}

/** Creates a standards-compatible store-only ZIP without another runtime dependency. */
export function createZip(entries:ZipEntry[]):Uint8Array{
  const localParts:Uint8Array[]=[];const centralParts:Uint8Array[]=[];let localOffset=0
  for(const entry of entries){
    const name=encoder.encode(entry.name),data=typeof entry.data==='string'?encoder.encode(entry.data):entry.data,crc=crc32(data)
    const local=new Uint8Array(30+name.length);const lv=new DataView(local.buffer);u32(lv,0,0x04034b50);u16(lv,4,20);u16(lv,6,0x0800);u16(lv,8,0);u32(lv,14,crc);u32(lv,18,data.length);u32(lv,22,data.length);u16(lv,26,name.length);local.set(name,30);localParts.push(local,data)
    const central=new Uint8Array(46+name.length);const cv=new DataView(central.buffer);u32(cv,0,0x02014b50);u16(cv,4,20);u16(cv,6,20);u16(cv,8,0x0800);u16(cv,10,0);u32(cv,16,crc);u32(cv,20,data.length);u32(cv,24,data.length);u16(cv,28,name.length);u32(cv,42,localOffset);central.set(name,46);centralParts.push(central);localOffset+=local.length+data.length
  }
  const central=concat(centralParts),end=new Uint8Array(22);const ev=new DataView(end.buffer);u32(ev,0,0x06054b50);u16(ev,8,entries.length);u16(ev,10,entries.length);u32(ev,12,central.length);u32(ev,16,localOffset)
  return concat([...localParts,central,end])
}
