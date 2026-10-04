/** Inspect bounded raster headers before admitting a poster. No decoding or execution. */
export function artifactImage(bytes){
 if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR')return {mime:'image/png',width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
 if(bytes.length<4||bytes[0]!==255||bytes[1]!==216)return null;
 let offset=2;
 while(offset+4<=bytes.length){
  if(bytes[offset++]!==255)return null;
  while(offset<bytes.length&&bytes[offset]===255)offset++;
  const marker=bytes[offset++];
  if(marker===217||marker===218)return null;
  if(marker===1||marker>=208&&marker<=215)continue;
  if(offset+2>bytes.length)return null;const length=bytes.readUInt16BE(offset);
  if(length<2||offset+length>bytes.length)return null;
  if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){
   if(length<8)return null;return {mime:'image/jpeg',width:bytes.readUInt16BE(offset+5),height:bytes.readUInt16BE(offset+3)};
  }
  offset+=length;
 }
 return null;
}
