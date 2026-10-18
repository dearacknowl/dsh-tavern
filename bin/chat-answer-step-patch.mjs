import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// DSH 0.2.1 的对话界面只把一轮的「最后一步」当作最终回复（latestAnswer）。
// 酒馆在一轮结算后把整理后的正文写回原生会话（replaceAssistantReply）；这时那一步已经结束，
// 替换只能记在新开的一步里，而这一步没有自己的回复节点。界面于是认为这一轮没有最终回复，
// 「工作步骤展示：简洁」时整轮正文被当作过程折叠（hidden="until-found"），玩家看到一片空白。
// 补丁让 latestAnswer 跳过末尾没有回复节点的步骤；最后一步本身就有回复时结果完全不变。
const FROM = '\t\tfunction latestAnswer(turn) {\n\t\t\tconst data = turn.steps.at(-1)?.data.get("assistant-step");'
const TO = '\t\tfunction latestAnswer(turn) {\n'
  + '\t\t\t// dsh-tavern: skip trailing steps without an assistant node (a settled reply rewritten in its own edit step).\n'
  + '\t\t\tlet index = turn.steps.length - 1;\n'
  + '\t\t\twhile (index > 0) {\n'
  + '\t\t\t\tconst tail = turn.steps[index]?.data.get("assistant-step");\n'
  + '\t\t\t\tif (tail !== void 0 && Array.isArray(tail.blocks) && tail.blocks.length > 0) break;\n'
  + '\t\t\t\tindex--;\n'
  + '\t\t\t}\n'
  + '\t\t\tconst data = turn.steps[index]?.data.get("assistant-step");'

/**
 * Patch the host chat client in place. Like the font-limit patch it is cosmetic
 * and version-independent: applied only when the anchor matches exactly once,
 * skipped (null) otherwise; repeated installation is a no-op (false).
 */
export function patchChatAnswerStep(directory) {
  const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh-client-ui-chat') throw new Error('回复步骤补丁仅适用于 dsh-client-ui-chat')
  const file = path.join(directory, 'lib', 'client.js')
  let before
  try { before = readFileSync(file, 'utf8') } catch { return null }
  // Accept either line ending; write back with the file's own.
  const crlf = before.includes('\r\n')
  const text = crlf ? before.replace(/\r\n/g, '\n') : before
  if (text.split(TO).length === 2) return false
  if (text.split(FROM).length !== 2) return null
  const after = text.replace(FROM, () => TO)
  writeFileSync(file, crlf ? after.replace(/\n/g, '\r\n') : after)
  return true
}
