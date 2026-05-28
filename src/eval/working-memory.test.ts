import { describe, expect, it } from 'vitest'
import { evaluateSuite, evaluateWorkingMemory } from './working-memory.js'
import { workingMemoryGoldenCases } from './golden/working-memory.js'

describe('working-memory eval harness', () => {
  it('passes the committed golden cases', () => {
    const reports = evaluateSuite(workingMemoryGoldenCases)
    expect(workingMemoryGoldenCases.length).toBeGreaterThanOrEqual(30)
    expect(reports.every((report) => report.passed)).toBe(true)
  })

  it('catches hallucinated source receipts', () => {
    const testCase = structuredClone(workingMemoryGoldenCases[0])
    testCase.output.focus_items[0]!.source_ids = [{ table: 'tasks', id: 'not_in_context' }]

    const report = evaluateWorkingMemory(testCase)

    expect(report.passed).toBe(false)
    expect(report.findings.some((finding) => finding.message.includes('not present in the input context'))).toBe(true)
  })

  it('catches second-person working-memory copy', () => {
    const testCase = structuredClone(workingMemoryGoldenCases[0])
    testCase.output.focus_items[0]!.text = 'Your Anthropic cover letter needs paragraph two before Friday.'

    const report = evaluateWorkingMemory(testCase)

    expect(report.passed).toBe(false)
    expect(report.findings.some((finding) => finding.message.includes('second person'))).toBe(true)
  })

  it('catches quiet items that are too fresh', () => {
    const testCase = structuredClone(workingMemoryGoldenCases[0])
    testCase.output.quiet_items[0]!.last_active_at = '2026-05-24T12:00:00Z'

    const report = evaluateWorkingMemory(testCase)

    expect(report.passed).toBe(false)
    expect(report.findings.some((finding) => finding.message.includes('minimum is 10'))).toBe(true)
  })

  it('catches hallucinated dates', () => {
    const testCase = structuredClone(workingMemoryGoldenCases[0])
    testCase.output.focus_items[0]!.text = 'The Anthropic cover letter still turns on paragraph two before Monday.'

    const report = evaluateWorkingMemory(testCase)

    expect(report.passed).toBe(false)
    expect(report.findings.some((finding) => finding.message.includes('temporal reference'))).toBe(true)
  })

  it('warns on generic copy', () => {
    const testCase = structuredClone(workingMemoryGoldenCases[0])
    testCase.output.focus_items[0]!.text = 'The project still needs something before Friday.'

    const report = evaluateWorkingMemory(testCase)

    expect(report.findings.some((finding) => finding.message.includes('generic copy'))).toBe(true)
  })
})
