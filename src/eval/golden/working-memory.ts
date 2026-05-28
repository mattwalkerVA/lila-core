import type { WorkingMemoryEvalCase } from '../working-memory.js'

export const workingMemoryGoldenCases: WorkingMemoryEvalCase[] = [
  {
    id: 'first-real-week',
    description: 'A mixed week with one deadline, one person thread, and one legitimately stale project.',
    input: {
      first_name: 'Matt',
      current_date: '2026-05-27',
      lookback_window_days: 14,
      previous_working_memory: null,
      recent_activity: [
        {
          record: { table: 'tasks', id: 'task_cover_letter' },
          kind: 'task',
          ts: '2026-05-26T15:00:00Z',
          title: 'Send Anthropic cover letter',
          status: 'open',
          due: '2026-05-29T21:00:00Z',
          note: 'Sarah said paragraph two is the only weak spot.',
        },
        {
          record: { table: 'messages', id: 'msg_sarah_cover_letter' },
          kind: 'message',
          ts: '2026-05-26T18:30:00Z',
          from: 'Sarah',
          text: 'Send me paragraph two before Friday and I will do one last pass.',
        },
        {
          record: { table: 'captures', id: 'cap_podcast_idea' },
          kind: 'capture',
          ts: '2026-05-09T12:00:00Z',
          text: 'Podcast idea: interview founders after the thing stops being shiny.',
        },
      ],
      retrieved_memories: [],
    },
    output: {
      greeting_context: null,
      focus_items: [
        {
          text: 'The Anthropic cover letter still turns on paragraph two before Friday.',
          source_ids: [
            { table: 'tasks', id: 'task_cover_letter' },
            { table: 'messages', id: 'msg_sarah_cover_letter' },
          ],
          salience: 0.92,
        },
      ],
      people_threads: [
        {
          person: 'Sarah',
          items: [
            {
              text: 'Waiting on paragraph two for the cover-letter pass.',
              source_ids: [{ table: 'messages', id: 'msg_sarah_cover_letter' }],
            },
          ],
        },
      ],
      quiet_items: [
        {
          text: 'The founder podcast idea has not moved since May 9.',
          source_ids: [{ table: 'captures', id: 'cap_podcast_idea' }],
          last_active_at: '2026-05-09T12:00:00Z',
        },
      ],
    },
    expectations: {
      requiredFocusIncludes: ['Anthropic cover letter'],
      requiredSources: [
        { table: 'tasks', id: 'task_cover_letter' },
        { table: 'messages', id: 'msg_sarah_cover_letter' },
      ],
    },
  },
  {
    id: 'quiet-day',
    description: 'No live commitments should stay quiet instead of inventing work.',
    input: {
      first_name: 'Matt',
      current_date: '2026-05-27',
      lookback_window_days: 7,
      previous_working_memory: null,
      recent_activity: [
        {
          record: { table: 'captures', id: 'cap_weather' },
          kind: 'capture',
          ts: '2026-05-26T11:00:00Z',
          text: 'The weather finally stopped being annoying.',
        },
      ],
      retrieved_memories: [],
    },
    output: {
      greeting_context: null,
      focus_items: [],
      people_threads: [],
      quiet_items: [],
    },
  },
  {
    id: 'carry-forward-with-receipts',
    description: 'Still-true previous memory may carry forward if the original source receipt is preserved.',
    input: {
      first_name: 'Matt',
      current_date: '2026-05-27',
      lookback_window_days: 7,
      previous_working_memory: {
        greeting_context: null,
        focus_items: [
          {
            text: 'The bathroom tile decision is still blocking the contractor quote.',
            source_ids: [{ table: 'tasks', id: 'task_tile_decision' }],
            salience: 0.84,
          },
        ],
        people_threads: [],
        quiet_items: [],
      },
      recent_activity: [
        {
          record: { table: 'captures', id: 'cap_tile_followup' },
          kind: 'capture',
          ts: '2026-05-26T20:00:00Z',
          text: 'Still no tile decision. Need to choose between zellige and the boring clean white one.',
        },
      ],
      retrieved_memories: [],
    },
    output: {
      greeting_context: null,
      focus_items: [
        {
          text: 'The bathroom tile decision is still blocking the contractor quote.',
          source_ids: [
            { table: 'tasks', id: 'task_tile_decision' },
            { table: 'captures', id: 'cap_tile_followup' },
          ],
          salience: 0.84,
        },
      ],
      people_threads: [],
      quiet_items: [],
    },
    expectations: {
      requiredFocusIncludes: ['bathroom tile'],
      requiredSources: [{ table: 'tasks', id: 'task_tile_decision' }],
    },
  },
]
