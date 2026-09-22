import test from 'node:test';
import assert from 'node:assert/strict';
import {admitDiagramSource, admitDiagramGraph, DIAGRAM_LIMITS} from '../src/technical-diagram-policy.ts';

test('static diagram types and exact neutral fixtures are admitted without changing source', () => {
  for (const [source, kind] of [
    ['flowchart LR\n S[Sensor capture] --> H[Authenticated hub]\n H --> M[Monitor display]\n M -->|Requested setting| H\n H -->|Acknowledged setting| M', 'flowchart'],
    ['sequenceDiagram\n participant M as Monitor\n participant S as Sensor\n M->>S: Request rate with request ID\n S-->>M: Applied rate and capture epoch', 'sequence'],
    ['stateDiagram-v2\n [*] --> Disconnected\n Disconnected --> Connected: pair\n Connected --> Stale: timeout\n Stale --> Connected: fresh sample', 'state'],
  ]) assert.equal(admitDiagramSource(source), kind);
});
test('configuration, HTML, remote content, callbacks, CSS and unsupported types fail closed', () => {
  for (const source of ['%%{init: {securityLevel: "loose"}}%%\nflowchart LR\nA-->B','---\nconfig: {}\n---\nflowchart LR\nA-->B','flowchart LR\n A[<img src=x onerror=alert(1)>]','flowchart LR\n A[&#60;script&#62;]','flowchart LR\n click A callback','flowchart LR; click A "https://example.org"','sequenceDiagram\nlink A: Link @ file:///tmp/x','flowchart LR\nclassDef default fill:red','flowchart LR\nA@{img: "x"}','flowchart LR\nA[$$x$$]','pie\n"a": 3','stateDiagram\nA-->B']) assert.throws(() => admitDiagramSource(source), source);
});
test('source bounds reject expensive input before Mermaid import or layout', () => {
  for (const source of ['flowchart LR\n'+'x'.repeat(DIAGRAM_LIMITS.source), 'flowchart LR\n'+'A-->B\n'.repeat(81), 'flowchart LR\n'+'a '.repeat(601), 'flowchart LR\n'+'A-->B;'.repeat(81), 'flowchart LR\n'+Array.from({length:5},(_,i)=>`subgraph s${i}`).join('\n')]) assert.throws(() => admitDiagramSource(source), /limit/);
});
test('parsed counts catch implicit or compound graphs and unsupported database changes', () => {
  assert.deepEqual(admitDiagramGraph('flowchart',{getVertices:()=>new Map([['a',{}],['b',{}]]),getEdges:()=>[{}]}),{nodes:2,edges:1});
  assert.throws(()=>admitDiagramGraph('flowchart',{getVertices:()=>new Map(Array.from({length:49},(_,i)=>[i,{}])),getEdges:()=>[]}),/48 nodes/);
  assert.throws(()=>admitDiagramGraph('sequence',{getActors:()=>new Map(),getMessages:()=>Array(81)}),/80 edges/);
  assert.throws(()=>admitDiagramGraph('state',{getData:()=>({nodes:Array(49),edges:[]})}),/48 nodes/);
  assert.throws(()=>admitDiagramGraph('state',{}),/cannot be checked/);
});
test('sequence control nesting is bounded before parsing', () => {
  for (const keyword of ['loop','alt','opt','par','critical','break','rect','box']) {
    assert.throws(()=>admitDiagramSource('sequenceDiagram\n'+`${keyword} outer\n`.repeat(5)+'A->>B: message\n'+'end\n'.repeat(5)),/nesting/);
    assert.equal(admitDiagramSource('sequenceDiagram\n'+`${keyword} outer\n`.repeat(4)+'A->>B: message\n'+'end\n'.repeat(4)), 'sequence');
  }
});
test('custom class shorthand cannot attach application CSS to diagram nodes', () => {
  for (const source of ['flowchart LR\nA:::fw-window-->B', 'stateDiagram-v2\nA:::fw-window --> B']) assert.throws(()=>admitDiagramSource(source), /custom styles/);
});
