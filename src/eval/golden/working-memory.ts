import type { WorkingMemoryEvalCase } from '../working-memory.js'

const baseWorkingMemoryGoldenCases: WorkingMemoryEvalCase[] = [
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

const deadlineCases: WorkingMemoryEvalCase[] = [
  ['kestrel-invoice', 'Kestrel invoice', 'the finance folder', 'task_kestrel_invoice'],
  ['mara-demo', 'Mara demo script', 'the Wednesday walkthrough', 'task_mara_demo'],
  ['tile-order', 'Bathroom tile order', 'the contractor quote', 'task_tile_order'],
  ['visa-renewal', 'Visa renewal packet', 'the consulate appointment', 'task_visa_packet'],
  ['lucia-school', 'Lucia school form', 'the enrollment deadline', 'task_lucia_school'],
  ['shorebreak-taxes', 'Shorebreak tax export', 'the accountant handoff', 'task_tax_export'],
  ['camera-return', 'Camera return label', 'the return window', 'task_camera_return'],
  ['book-proposal', 'Book proposal outline', 'the agent call', 'task_book_outline'],
  ['server-renewal', 'Server renewal decision', 'the May 30 renewal', 'task_server_renewal'],
  ['rooftop-quote', 'Rooftop quote reply', 'the contractor calendar', 'task_rooftop_quote'],
  ['grant-budget', 'Grant budget table', 'the submission packet', 'task_grant_budget'],
  ['dentist-forms', 'Dentist intake forms', 'the Monday appointment', 'task_dentist_forms'],
].map(([slug, title, stakes, id], i) => ({
  id: `deadline-${slug}`,
  description: `Deadline prioritization for ${title}.`,
  input: {
    first_name: 'Matt',
    current_date: '2026-05-27',
    lookback_window_days: 7,
    previous_working_memory: null,
    recent_activity: [{
      record: { table: 'tasks', id },
      kind: 'task',
      ts: '2026-05-26T10:00:00Z',
      title,
      status: 'open',
      due: '2026-05-30T18:00:00Z',
      note: `${title} is still needed for ${stakes}.`,
    }],
    retrieved_memories: [],
  },
  output: {
    greeting_context: null,
    focus_items: [{
      text: `${title} is still needed for ${stakes}.`,
      source_ids: [{ table: 'tasks', id }],
      salience: 0.8 + i * 0.005,
    }],
    people_threads: [],
    quiet_items: [],
  },
  expectations: {
    requiredFocusIncludes: [title],
    requiredSources: [{ table: 'tasks', id }],
  },
} as WorkingMemoryEvalCase))

const quietCases: WorkingMemoryEvalCase[] = [
  ['greenhouse-plan', 'Greenhouse plan', 'cap_greenhouse_plan', '2026-05-06T12:00:00Z'],
  ['letterpress-card', 'Letterpress card idea', 'cap_letterpress_card', '2026-05-05T12:00:00Z'],
  ['archive-export', 'Archive export', 'cap_archive_export', '2026-05-04T12:00:00Z'],
  ['sleep-study', 'Sleep study notes', 'cap_sleep_study', '2026-05-03T12:00:00Z'],
  ['mentor-list', 'Mentor list', 'cap_mentor_list', '2026-05-02T12:00:00Z'],
  ['kitchen-shelves', 'Kitchen shelves', 'cap_kitchen_shelves', '2026-05-01T12:00:00Z'],
  ['camp-packing', 'Camp packing list', 'cap_camp_packing', '2026-04-30T12:00:00Z'],
  ['old-domain', 'Old domain cleanup', 'cap_old_domain', '2026-04-29T12:00:00Z'],
].map(([slug, title, id, ts]) => ({
  id: `quiet-${slug}`,
  description: `Stale but alive capture for ${title}.`,
  input: {
    first_name: 'Matt',
    current_date: '2026-05-27',
    lookback_window_days: 30,
    previous_working_memory: null,
    recent_activity: [{
      record: { table: 'captures', id },
      kind: 'capture',
      ts,
      text: `${title}: still worth deciding whether this is alive.`,
    }],
    retrieved_memories: [],
  },
  output: {
    greeting_context: null,
    focus_items: [],
    people_threads: [],
    quiet_items: [{
      text: `${title} has not moved since the first note.`,
      source_ids: [{ table: 'captures', id }],
      last_active_at: ts,
    }],
  },
  expectations: {
    requiredSources: [{ table: 'captures', id }],
  },
} as WorkingMemoryEvalCase))

const peopleThreadCases: WorkingMemoryEvalCase[] = [
  ['Sarah', 'portfolio screenshots', 'msg_sarah_screenshots'],
  ['Ari', 'contract redlines', 'msg_ari_redlines'],
  ['Mina', 'Saturday lunch time', 'msg_mina_lunch'],
  ['Jo', 'warehouse visit', 'msg_jo_warehouse'],
  ['Nadia', 'speaker bio', 'msg_nadia_bio'],
  ['Luis', 'invoice approval', 'msg_luis_invoice'],
  ['Priya', 'research handoff', 'msg_priya_research'],
].map(([person, subject, id]) => ({
  id: `people-${person.toLowerCase()}`,
  description: `Open loop with ${person} about ${subject}.`,
  input: {
    first_name: 'Matt',
    current_date: '2026-05-27',
    lookback_window_days: 7,
    previous_working_memory: null,
    recent_activity: [{
      record: { table: 'messages', id },
      kind: 'message',
      ts: '2026-05-26T14:00:00Z',
      from: person,
      text: `${person} is waiting on ${subject}.`,
    }],
    retrieved_memories: [],
  },
  output: {
    greeting_context: null,
    focus_items: [],
    people_threads: [{
      person,
      items: [{
        text: `Waiting on ${subject}.`,
        source_ids: [{ table: 'messages', id }],
      }],
    }],
    quiet_items: [],
  },
  expectations: {
    requiredSources: [{ table: 'messages', id }],
  },
} as WorkingMemoryEvalCase))

export const workingMemoryGoldenCases: WorkingMemoryEvalCase[] = [
  ...baseWorkingMemoryGoldenCases,
  ...deadlineCases,
  ...quietCases,
  ...peopleThreadCases,
]
