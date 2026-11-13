import test from 'node:test';
import assert from 'node:assert/strict';
import { diffText } from '../src/diff.js';
test('diff reconstructs original and result without HTML interpretation',()=>{
 for(const [a,b] of [['她走了','她慢慢走了'],['abc','adc'],['<script>x</script>','<b>x</b>'],['','新'],['删',''],['相同','相同'],['a'.repeat(2000),'b'.repeat(2000)]]) {
 const ops=diffText(a,b);
 assert.equal(ops.filter(x=>x.type!=='add').map(x=>x.text).join(''),a);
 assert.equal(ops.filter(x=>x.type!=='remove').map(x=>x.text).join(''),b);
 }
});
