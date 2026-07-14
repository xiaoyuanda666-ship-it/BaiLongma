import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { paths } from './paths.js'
import { refreshSkills, selectSkillsForMessage, formatSkillsForContext } from './skills/registry.js'

const sandboxSkillDir = path.join(paths.sandboxSkillsDir, '__test-sandbox-skill')
fs.rmSync(sandboxSkillDir, { recursive: true, force: true })
fs.mkdirSync(sandboxSkillDir, { recursive: true })
fs.writeFileSync(path.join(sandboxSkillDir, 'SKILL.md'), `---
name: Sandbox Test Skill
description: Test-only skill installed from inside Jarvis sandbox.
aliases:
  - sandbox skill test
---

# Sandbox Test Skill

This skill proves sandbox-installed skills are discoverable.
`, 'utf8')

const skills = refreshSkills()
assert.ok(skills.length >= 1, 'expected at least one skill to be discovered')

const agentSkill = skills.find(s => s.id === 'agent-skills' || s.name === 'Agent Skills')
assert.ok(agentSkill, 'expected bundled Agent Skills helper skill')
assert.equal(agentSkill.name, 'Agent Skills')
assert.ok(agentSkill.description.includes('Jarvis Agent Skills'))

const matched = selectSkillsForMessage('帮我创建一个 Agent Skills 的 SKILL.md')
assert.ok(matched.active.some(s => s.name === 'Agent Skills'), 'expected Agent Skills to activate')

const catalog = selectSkillsForMessage('有哪些技能可以用')
assert.equal(catalog.catalogRequested, true)

const context = formatSkillsForContext(matched)
assert.ok(context.includes('<agent-skills>'), 'expected active skills context')
assert.ok(context.includes('SKILL.md'), 'expected full skill instructions in context')

const sandboxMatched = selectSkillsForMessage('run sandbox skill test')
assert.ok(sandboxMatched.active.some(s => s.name === 'Sandbox Test Skill' && s.source === 'sandbox'), 'expected sandbox-installed skill to activate')

fs.rmSync(sandboxSkillDir, { recursive: true, force: true })
refreshSkills()

console.log('Agent Skills tests passed')
