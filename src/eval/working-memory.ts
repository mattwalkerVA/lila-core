import { validate, type ValidationIssue } from '../memory/consolidation.js'
import type { ConsolidationInput, ConsolidationOutput, SourceRef } from '../memory/types.js'

export interface WorkingMemoryExpectation {
  requiredFocusIncludes?: string[]
  forbiddenTextIncludes?: string[]
  requiredSources?: SourceRef[]
}

export interface WorkingMemoryEvalCase {
  id: string
  description: string
  input: ConsolidationInput
  output: ConsolidationOutput
  expectations?: WorkingMemoryExpectation
}

export interface EvalFinding {
  severity: 'error' | 'warn'
  path: string
  message: string
}

export interface EvalReport {
  id: string
  passed: boolean
  score: number
  findings: EvalFinding[]
  structuralIssues: ValidationIssue[]
}

const BANNED_PHRASES = [
  'great question',
  'just a friendly reminder',
  'it seems like',
  'it appears that',
  'perhaps',
  'worth noting',
  'leverage',
  'optimize',
  'actionable',
  'empower',
  'unlock',
  'streamline',
  'robust',
  'seamless',
  'holistic',
  'synergy',
  'bandwidth',
]

const SECOND_PERSON = /\b(you|your|yours|yourself)\b/i
const TEMPORAL_TOKEN = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{4}-\d{2}-\d{2})\b/ig
const GENERIC_COPY = /\b(stuff|things|something|that project|the project|follow up)\b/i

export function evaluateWorkingMemory(testCase: WorkingMemoryEvalCase): EvalReport {
  const findings: EvalFinding[] = []
  const structuralIssues = validate(testCase.output)
  for (const issue of structuralIssues) {
    findings.push({ severity: 'error', path: issue.path, message: issue.message })
  }

  const validSources = collectValidSources(testCase.input)
  const allowedTemporalTerms = collectAllowedTemporalTerms(testCase.input)
  const bullets = collectBullets(testCase.output)

  for (const bullet of bullets) {
    const wordCount = bullet.text.trim().split(/\s+/).filter(Boolean).length
    if (wordCount > 18) {
      findings.push({
        severity: 'warn',
        path: bullet.path,
        message: `bullet has ${wordCount} words; prompt target is <=18`,
      })
    }
    if (SECOND_PERSON.test(bullet.text)) {
      findings.push({
        severity: 'error',
        path: bullet.path,
        message: 'uses second person; working memory should talk about the user, not at them',
      })
    }
    for (const phrase of BANNED_PHRASES) {
      if (bullet.text.toLowerCase().includes(phrase)) {
        findings.push({ severity: 'error', path: bullet.path, message: `contains banned phrase: ${phrase}` })
      }
    }
    if (GENERIC_COPY.test(bullet.text)) {
      findings.push({
        severity: 'warn',
        path: bullet.path,
        message: 'uses generic copy where Lila should name the specific referent',
      })
    }
    for (const token of temporalTokens(bullet.text)) {
      if (!allowedTemporalTerms.has(token.toLowerCase())) {
        findings.push({
          severity: 'error',
          path: bullet.path,
          message: `temporal reference "${token}" is not grounded in the input`,
        })
      }
    }
    for (const source of bullet.source_ids) {
      if (!validSources.has(sourceKey(source))) {
        findings.push({
          severity: 'error',
          path: `${bullet.path}.source_ids`,
          message: `source ${source.table}:${source.id} is not present in the input context`,
        })
      }
    }
  }

  for (const [i, item] of testCase.output.quiet_items.entries()) {
    const ageDays = daysBetween(item.last_active_at, testCase.input.current_date)
    if (ageDays < 10) {
      findings.push({
        severity: 'error',
        path: `$.quiet_items[${i}].last_active_at`,
        message: `quiet item is only ${ageDays} days old; minimum is 10`,
      })
    }
  }

  const expectations = testCase.expectations
  if (expectations?.requiredFocusIncludes) {
    const focusText = testCase.output.focus_items.map((f) => f.text.toLowerCase()).join('\n')
    for (const needle of expectations.requiredFocusIncludes) {
      if (!focusText.includes(needle.toLowerCase())) {
        findings.push({
          severity: 'error',
          path: '$.focus_items',
          message: `missing expected focus phrase: ${needle}`,
        })
      }
    }
  }
  if (expectations?.forbiddenTextIncludes) {
    const allText = bullets.map((b) => b.text.toLowerCase()).join('\n')
    for (const needle of expectations.forbiddenTextIncludes) {
      if (allText.includes(needle.toLowerCase())) {
        findings.push({
          severity: 'error',
          path: '$',
          message: `contains forbidden phrase: ${needle}`,
        })
      }
    }
  }
  if (expectations?.requiredSources) {
    const emittedSources = new Set(bullets.flatMap((b) => b.source_ids.map(sourceKey)))
    for (const source of expectations.requiredSources) {
      if (!emittedSources.has(sourceKey(source))) {
        findings.push({
          severity: 'error',
          path: '$',
          message: `missing required source receipt: ${source.table}:${source.id}`,
        })
      }
    }
  }

  const errors = findings.filter((f) => f.severity === 'error').length
  const warnings = findings.filter((f) => f.severity === 'warn').length
  const score = Math.max(0, 1 - errors * 0.2 - warnings * 0.05)

  return {
    id: testCase.id,
    passed: errors === 0,
    score,
    findings,
    structuralIssues,
  }
}

export function evaluateSuite(cases: WorkingMemoryEvalCase[]): EvalReport[] {
  return cases.map(evaluateWorkingMemory)
}

function collectValidSources(input: ConsolidationInput): Set<string> {
  const out = new Set<string>()
  for (const item of input.recent_activity) out.add(sourceKey(item.record))
  if (input.previous_working_memory) {
    for (const bullet of collectBullets(input.previous_working_memory)) {
      for (const source of bullet.source_ids) out.add(sourceKey(source))
    }
  }
  return out
}

function collectAllowedTemporalTerms(input: ConsolidationInput): Set<string> {
  const out = new Set<string>()
  out.add(input.current_date.toLowerCase())
  for (const value of collectStrings(input)) {
    for (const token of temporalTokens(value)) out.add(token.toLowerCase())
    const date = parseDate(value)
    if (date) {
      for (const term of renderDateTerms(date)) out.add(term.toLowerCase())
    }
  }
  return out
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(collectStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectStrings)
  return []
}

function temporalTokens(text: string): string[] {
  return Array.from(text.matchAll(TEMPORAL_TOKEN)).map((m) => m[0])
}

function parseDate(value: string): Date | null {
  if (!/\d{4}-\d{2}-\d{2}/.test(value)) return null
  const d = new Date(value)
  return Number.isNaN(d.valueOf()) ? null : d
}

function renderDateTerms(date: Date): string[] {
  const month = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(date)
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(date)
  const day = new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'UTC' }).format(date)
  return [month, `${month} ${day}`, weekday]
}

function collectBullets(output: ConsolidationOutput): Array<{ path: string; text: string; source_ids: SourceRef[] }> {
  const out: Array<{ path: string; text: string; source_ids: SourceRef[] }> = []
  output.focus_items.forEach((item, i) => out.push({ path: `$.focus_items[${i}]`, text: item.text, source_ids: item.source_ids }))
  output.people_threads.forEach((thread, i) => {
    thread.items.forEach((item, j) => out.push({
      path: `$.people_threads[${i}].items[${j}]`,
      text: item.text,
      source_ids: item.source_ids,
    }))
  })
  output.quiet_items.forEach((item, i) => out.push({ path: `$.quiet_items[${i}]`, text: item.text, source_ids: item.source_ids }))
  return out
}

function sourceKey(source: SourceRef): string {
  return `${source.table}:${source.id}`
}

function daysBetween(isoDateOrDateTime: string, currentDate: string): number {
  const start = new Date(isoDateOrDateTime)
  const end = new Date(`${currentDate}T00:00:00Z`)
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) return -1
  return Math.floor((end.valueOf() - start.valueOf()) / 86_400_000)
}

export function formatEvalReports(reports: EvalReport[]): string {
  const lines: string[] = []
  const passed = reports.filter((r) => r.passed).length
  lines.push(`working-memory eval: ${passed}/${reports.length} passed`)
  for (const report of reports) {
    const marker = report.passed ? 'PASS' : 'FAIL'
    lines.push(`${marker} ${report.id} score=${report.score.toFixed(2)}`)
    for (const finding of report.findings) {
      lines.push(`  ${finding.severity.toUpperCase()} ${finding.path}: ${finding.message}`)
    }
  }
  return lines.join('\n')
}
