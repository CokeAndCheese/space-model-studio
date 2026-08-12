import { describe,expect,it } from 'vitest'
import { createZip } from '../src/export/zip'
describe('project package zip',()=>{it('writes local, central and end records',()=>{const bytes=createZip([{name:'A_1F.glb',data:new Uint8Array([1,2,3])},{name:'audit-report.json',data:'{}'}]),view=new DataView(bytes.buffer);expect(view.getUint32(0,true)).toBe(0x04034b50);expect(new TextDecoder().decode(bytes)).toContain('audit-report.json');expect(view.getUint32(bytes.length-22,true)).toBe(0x06054b50)})})
