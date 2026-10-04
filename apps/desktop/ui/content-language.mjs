// Document metadata describes content, never a filename, schema migration or UI language.
const languages = new Map([['en','en'],['zh','zh'],['zh-hans','zh-Hans'],['zh-hant','zh-Hant'],['zh-cn','zh-CN'],['zh-tw','zh-TW'],['zh-hk','zh-HK']]);
export function contentLanguage(source) {
 const text = source.replace(/^\ufeff/, '');
 if (/^---\r?\n/.test(text)) {
  const end = text.slice(4).search(/^---\s*$/m);
  if (end >= 0) {
   const metadata = text.slice(4, end + 4);
   const match = /^lang:[ \t]*["']?([A-Za-z-]+)["']?[ \t]*\r?$/m.exec(metadata);
   if (match && languages.has(match[1].toLowerCase())) return languages.get(match[1].toLowerCase());
  }
 }
 // Do not infer Simplified versus Traditional from shared Han characters.
 return /\p{Script=Han}/u.test(text) ? 'zh' : 'en';
}
const segmenters=new Map();
export function documentStatistics(source) {
 const locale = contentLanguage(source);
 if(!segmenters.has(locale))segmenters.set(locale,{words:new Intl.Segmenter(locale,{granularity:'word'}),characters:new Intl.Segmenter(locale,{granularity:'grapheme'})});
 const {words,characters}=segmenters.get(locale);
 return {words:Array.from(words.segment(source)).filter(s=>s.isWordLike).length,
  characters:Array.from(characters.segment(source)).length, lines:source.split('\n').length};
}
