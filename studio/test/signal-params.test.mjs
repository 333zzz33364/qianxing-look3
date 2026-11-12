import test from 'node:test'
import assert from 'node:assert/strict'
import { SIGNAL_PARAM_TYPES, createSignalParam, serializeSignalParam, serializeSignalParams, signalParamHint } from '../../editor-ui/signal-params.js'

test('typed parameter rows start from a valid default for every offered type', () => {
  for (const type of SIGNAL_PARAM_TYPES) {
    const row = createSignalParam(type)
    assert.equal(row.type, type)
    assert.doesNotThrow(() => serializeSignalParam(row), `${type} 的默认值应可直接发送`)
  }
  assert.throws(() => createSignalParam('Guid'), /未知参数类型/)
  assert.match(signalParamHint('Vector3'), /\{.*x.*\}/)
  assert.match(signalParamHint('IntList'), /JSON 数组/)
})

test('integers only accept whole numbers while floats accept decimals', () => {
  assert.deepEqual(serializeSignalParam({ type: 'Int', value: '42' }), { type: 'Int', value: 42 })
  assert.deepEqual(serializeSignalParam({ type: 'Int', value: -3 }), { type: 'Int', value: -3 })
  assert.throws(() => serializeSignalParam({ type: 'Int', value: '1.5' }), /必须是整数/)
  assert.throws(() => serializeSignalParam({ type: 'Int', value: '' }), /需要填写数字/)
  assert.throws(() => serializeSignalParam({ type: 'Int', value: 'abc' }), /必须是数字/)
  assert.deepEqual(serializeSignalParam({ type: 'Float', value: '1.5' }), { type: 'Float', value: 1.5 })
})

test('strings and booleans keep their own shapes', () => {
  assert.deepEqual(serializeSignalParam({ type: 'String', value: '你好' }), { type: 'String', value: '你好' })
  assert.deepEqual(serializeSignalParam({ type: 'String', value: 7 }), { type: 'String', value: '7' })
  assert.deepEqual(serializeSignalParam({ type: 'Bool', value: false }), { type: 'Bool', value: false })
  assert.throws(() => serializeSignalParam({ type: 'Bool', value: 'true' }), /必须是布尔值/)
})

test('list and vector parameters validate every element', () => {
  assert.deepEqual(serializeSignalParam({ type: 'IntList', value: '[1, "2"]' }), { type: 'IntList', value: [1, 2] })
  assert.deepEqual(serializeSignalParam({ type: 'FloatList', value: '[1.5]' }), { type: 'FloatList', value: [1.5] })
  assert.deepEqual(serializeSignalParam({ type: 'StringList', value: '["a", 2]' }), { type: 'StringList', value: ['a', '2'] })
  assert.deepEqual(serializeSignalParam({ type: 'BoolList', value: '[true, false]' }), { type: 'BoolList', value: [true, false] })
  assert.deepEqual(serializeSignalParam({ type: 'Vector3', value: '{"x":1,"y":2,"z":3}' }), { type: 'Vector3', value: { x: 1, y: 2, z: 3 } })
  assert.throws(() => serializeSignalParam({ type: 'IntList', value: '[1.5]' }), /\[0\].*必须是整数/)
  assert.throws(() => serializeSignalParam({ type: 'BoolList', value: '[1]' }), /\[0\].*必须是布尔值/)
  assert.throws(() => serializeSignalParam({ type: 'Vector3', value: '[1,2,3]' }), /必须是 \{"x","y","z"\} 对象/)
  assert.throws(() => serializeSignalParam({ type: 'Vector3', value: '{"x":1,"y":2}' }), /\.z 必须是数字/)
})

test('the list serializer reports which parameter row is wrong and keeps order', () => {
  const rows = [createSignalParam('Int'), createSignalParam('String'), { type: 'Bool', value: true }]
  rows[0].value = '5'
  rows[1].value = 'ok'
  assert.deepEqual(serializeSignalParams(rows), [
    { type: 'Int', value: 5 },
    { type: 'String', value: 'ok' },
    { type: 'Bool', value: true },
  ])
  assert.deepEqual(serializeSignalParams([]), [])
  assert.throws(() => serializeSignalParams([createSignalParam('Int'), { type: 'Int', value: 'x' }]), /参数 2 必须是数字/)
  assert.throws(() => serializeSignalParams([{ type: 'Nope', value: 1 }]), /参数 1 的类型未知/)
})
