import { evaluateSuite, formatEvalReports } from './working-memory.js'
import { workingMemoryGoldenCases } from './golden/working-memory.js'

const reports = evaluateSuite(workingMemoryGoldenCases)
console.log(formatEvalReports(reports))

if (reports.some((report) => !report.passed)) {
  process.exitCode = 1
}
