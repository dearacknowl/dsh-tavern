import assert from 'node:assert/strict'
import test from 'node:test'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { patchThemeFontLimit } from '../bin/theme-font-limit.mjs'
import { patchChatAnswerStep } from '../bin/chat-answer-step-patch.mjs'
import { installHostSubprocessPatch } from '../tavern-plugin/lib/domain/host-subprocess-patch.js'

const native = { skip: !process.env.DSH_BOOT_MODULE }

async function restorePristineFontLimit(directory) {
  for (const name of ['index.js', 'client.js']) {
    const file = path.join(directory, 'lib', name)
    const code = await readFile(file, 'utf8')
    await writeFile(file, code
      .replace('const FONT_SIZE_MAX = 32;', 'const FONT_SIZE_MAX = 22;')
      .replace(/(variable: "--dsh-content-font-size",\s+min: 10,\s+max: )32,/, '$122,'))
  }
}

test('目标宿主字号补丁只扩大正文字号，重复安装幂等，锚点不符时跳过且不写入', native, async t => {
  const require = createRequire(process.env.DSH_BOOT_MODULE)
  const source = path.dirname(require.resolve('@deepseek-ai/dsh-client-ui-theme/package.json'))
  const directory = await mkdtemp(path.join(tmpdir(), 'tavern-theme-native-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await cp(source, directory, { recursive: true })
  // A host installed through Tavern is already patched; start every run from the pristine anchors.
  await restorePristineFontLimit(directory)
  assert.equal(patchThemeFontLimit(directory), true)
  assert.equal(patchThemeFontLimit(directory), false)
  for (const name of ['index.js', 'client.js']) {
    const code = await readFile(path.join(directory, 'lib', name), 'utf8')
    assert.match(code, /variable: "--dsh-content-font-size",\s+min: 10,\s+max: 32,/)
    assert.match(code, /variable: "--dsh-code-font-size",\s+min: 10,\s+max: 16,/)
    assert.match(code, /variable: "--dsh-terminal-font-size",\s+min: 10,\s+max: 20,/)
  }
  await cp(source, directory, { recursive: true })
  await restorePristineFontLimit(directory)
  const client = path.join(directory, 'lib/client.js')
  const host = path.join(directory, 'lib/index.js')
  const originalHost = await readFile(host, 'utf8')
  const drifted = (await readFile(client, 'utf8')).replace('max: 22,', 'max: 23,')
  await writeFile(client, drifted)
  assert.equal(patchThemeFontLimit(directory), null)
  assert.equal(await readFile(host, 'utf8'), originalHost)
  assert.equal(await readFile(client, 'utf8'), drifted)
})

test('目标宿主 Windows 子进程补丁可安装、共享并恢复，宿主文件不变', native, async () => {
  const require = createRequire(process.env.DSH_BOOT_MODULE)
  const { pathToFileURL } = await import('node:url')
  const entry = require.resolve('@deepseek-ai/dsh-subprocess-local')
  const { default: Local } = await import(pathToFileURL(entry).href)
  const before = await readFile(entry, 'utf8')
  const original = Local.prototype.spawn
  const restore = await installHostSubprocessPatch({ hostRequire: require, platform: 'win32' })
  try {
    assert.notEqual(Local.prototype.spawn, original)
    const second = await installHostSubprocessPatch({ hostRequire: require, platform: 'win32' })
    second()
    assert.notEqual(Local.prototype.spawn, original)
    assert.equal(await readFile(entry, 'utf8'), before)
  } finally { restore() }
  assert.equal(Local.prototype.spawn, original)
})

test('目标宿主对话界面补丁：末尾只有替换的步骤不再让整轮被当作过程，普通回合不变；重复安装幂等，锚点不符时跳过', native, async t => {
  const require = createRequire(process.env.DSH_BOOT_MODULE)
  const source = path.dirname(require.resolve('@deepseek-ai/dsh-client-ui-chat/package.json'))
  const directory = await mkdtemp(path.join(tmpdir(), 'tavern-chat-native-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await cp(source, directory, { recursive: true })
  const client = path.join(directory, 'lib/client.js')
  // A host installed through Tavern is already patched; start from the pristine anchor.
  await writeFile(client, (await readFile(client, 'utf8')).replace(/\t\t\t\/\/ dsh-tavern: skip trailing steps[\s\S]*?const data = turn\.steps\[index\]/, '\t\t\tconst data = turn.steps.at(-1)'))
  assert.equal(patchChatAnswerStep(directory), true)
  assert.equal(patchChatAnswerStep(directory), false)
  const code = await readFile(client, 'utf8')
  // Evaluate the patched function against Turn shapes; the two helpers mirror the host's own definitions.
  const body = code.match(/function latestAnswer\(turn\) \{[\s\S]*?\n\t\t\}/)[0]
  const latestAnswer = new Function('isFinalAssistant', 'hasAssistantReplyContent', body + '\nreturn latestAnswer')(
    data => data?.finalNode !== undefined,
    blocks => blocks.some(block => block.kind === 'text' && block.text.trim() !== ''))
  const step = data => ({ data: new Map(data === undefined ? [] : [['assistant-step', data]]) })
  const answer = { step: 1, finalNode: { seq: 7 }, blocks: [{ kind: 'reasoning', text: '想' }, { kind: 'text', text: '正文' }] }
  assert.equal(latestAnswer({ steps: [step(answer)] }), answer, 'ordinary single-step turn')
  assert.equal(latestAnswer({ steps: [step(answer), step(undefined)] }), answer, 'settled reply rewritten in its own step')
  assert.equal(latestAnswer({ steps: [step(answer), step({ step: 2, blocks: [] })] }), answer, 'empty trailing assistant step')
  const toolStep = { step: 1, finalNode: { seq: 3 }, blocks: [{ kind: 'tool-call' }] }
  const final = { step: 2, finalNode: { seq: 9 }, blocks: [{ kind: 'text', text: '最后' }] }
  assert.equal(latestAnswer({ steps: [step(toolStep), step(final)] }), final, 'tool turn keeps its real last step')
  assert.equal(latestAnswer({ steps: [step(final), step(toolStep)] }), null, 'a trailing tool call is still not an answer')
  await cp(source, directory, { recursive: true })
  const drifted = (await readFile(client, 'utf8')).replace(/function latestAnswer\(turn\) \{[\s\S]*?\n\t\t\}/, 'function latestAnswer(turn) {\n\t\t\treturn null;\n\t\t}')
  await writeFile(client, drifted)
  assert.equal(patchChatAnswerStep(directory), null)
  assert.equal(await readFile(client, 'utf8'), drifted)
})
