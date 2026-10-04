import test from 'node:test';
import assert from 'node:assert/strict';
import {contentLanguage,documentStatistics} from '../../apps/desktop/ui/content-language.mjs';
import {renderSourcePreview,localLink} from '../../apps/desktop/ui/markdown-preview.mjs';
import {courseKey,validateCourse} from '../../packages/asteach-plugin/course.mjs';
import {validTeacher,emptyTeacher} from '../../packages/asteach-plugin/settings.mjs';
import {isPortableRelativePath,portablePathKey} from '../../packages/source-foundation/src/domain/path-policy.mjs';
test('Chinese document language preserves explicit script without guessing shared characters',()=>{
 assert.equal(contentLanguage('---\nlang: zh-Hant\n---\n# 系統辨識'),'zh-Hant');
 assert.equal(contentLanguage('---\nlang: "zh-Hans"\n---\n# 系统辨识'),'zh-Hans');
 assert.equal(contentLanguage('机器人'),'zh');assert.equal(contentLanguage('---\nlang: onclick\n---\n机器人'),'zh');
 assert.equal(contentLanguage('English document'),'en');
});
test('Chinese words and visible characters are segmented independently of whitespace',()=>{
 const count=documentStatistics('机器人系统设计');assert.ok(count.words>1);assert.equal(count.characters,7);
 assert.equal(documentStatistics('👩🏽‍💻').characters,1);assert.equal(documentStatistics('e\u0301').characters,1);
 assert.equal(documentStatistics('Hello, world!').words,2);
});
test('Chinese rendering, encoded local filenames and headings retain meaning',()=>{
 const r=renderSourcePreview('# 系统辨识\n\n[实验](classes/系统辨识.md)\n\n| 周次 | 内容 |\n| --- | --- |\n| 01 | 課程介紹<br>实验 |\n');
 assert.equal(r.language,'zh');assert.equal(r.headings[0].title,'系统辨识');assert.match(r.html,/課程介紹<br>\s*实验/);
 assert.deepEqual(localLink('classes/%E7%B3%BB%E7%BB%9F%E8%BE%A8%E8%AF%86.md','instructor.md'),{path:'classes/系统辨识.md',fragment:''});
 assert.equal(isPortableRelativePath('课程/系统辨识.md'),true);assert.equal(portablePathKey('cafe\u0301.md'),portablePathKey('café.md'));
});
test('Chinese course and teacher display metadata retain ASCII GitHub identifiers',()=>{
 const c=validateCourse({schemaVersion:1,courseId:'00000000-0000-4000-8000-000000000001',code:'ROB7103/8103',name:'机器人系统设计 / 機器人系統設計',terms:[{year:2026,season:'autumn',source:{kind:'document',paths:['2026-autumn/课程.md']}}]});
 assert.equal(c.name,'机器人系统设计 / 機器人系統設計');assert.equal(courseKey(c.code),'ROB7103_8103');assert.throws(()=>courseKey('机器人'));
 assert.equal(validTeacher({...emptyTeacher(),givenNames:'朝阳',familyNames:'宋',publishedName:'宋朝阳',biography:'機器人研究與教學'}),true);
});
