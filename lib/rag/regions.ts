/**
 * Which Indian state a bylaws document belongs to, from the folder it sits
 * in under By_Laws ("MDDA UTTARAKHAND/...", "UTTAR PRADESH/..."). Documents
 * in no state's folder (NBC, ECSBC, NEC, the design reference books) are
 * national and apply everywhere.
 *
 * Used by the Bylaws tab's State dropdown: with a state chosen, the search
 * covers that state's documents and the national ones, the state's first,
 * and leaves out every other state's (see retrieve in lib/rag/answer.ts).
 *
 * Only folder names count, not file names: a file name is too loose
 * ("UK(UP_Zamindari...)" is an Uttarakhand bill that names Uttar Pradesh).
 */

/** Name shown in the dropdown, and the folder-name pattern that means it.
 * Authority abbreviations are listed only where they are unambiguous. */
const STATES: Array<[string, RegExp]> = [
  ['Andhra Pradesh', /andhra|\bapcrda\b/],
  ['Arunachal Pradesh', /arunachal/],
  ['Assam', /assam/],
  ['Bihar', /bihar/],
  ['Chhattisgarh', /chh?att?isgarh/],
  ['Delhi', /\bdelhi\b|\bdda\b/],
  ['Goa', /\bgoa\b/],
  ['Gujarat', /gujarat|\bgdcr\b|\bauda\b/],
  ['Haryana', /haryana|\bhuda\b|\bhsvp\b/],
  ['Himachal Pradesh', /himachal|\bhp\b/],
  ['Jammu and Kashmir', /jammu|kashmir/],
  ['Jharkhand', /jharkhand/],
  ['Karnataka', /karnataka|\bbbmp\b/],
  ['Kerala', /kerala|\bkmbr\b/],
  ['Madhya Pradesh', /madhya|\bmp\b/],
  ['Maharashtra', /maharashtra|\budcpr\b|\bmmrda\b|\bmcgm\b/],
  ['Manipur', /manipur/],
  ['Meghalaya', /meghalaya/],
  ['Mizoram', /mizoram/],
  ['Nagaland', /nagaland/],
  ['Odisha', /odisha|orissa/],
  ['Punjab', /punjab|\bgmada\b/],
  ['Rajasthan', /rajasthan/],
  ['Sikkim', /sikkim/],
  ['Tamil Nadu', /tamil|\bcmda\b/],
  ['Telangana', /telangana|\bhmda\b/],
  ['Tripura', /tripura/],
  ['Uttar Pradesh', /uttar[\s_-]*pradesh|\bup\b|\blda\b/],
  ['Uttarakhand', /uttarakhand|uttaranchal|\bmdda\b|dehra[\s_-]*dun/],
  ['West Bengal', /bengal|\bkmda\b/],
  ['Chandigarh', /chandigarh/],
  ['Puducherry', /puducherry|pondicherry/],
  ['Ladakh', /ladakh/],
]

/** The state a folder name stands for, or null. */
export function stateOfFolder(name: string): string | null {
  // Underscores and hyphens as spaces, so \b works on "MDDA_UTTARAKHAND".
  const n = name.toLowerCase().replace(/[_-]+/g, ' ')
  for (const [state, re] of STATES) if (re.test(n)) return state
  return null
}

/** The state of a document from its folders (not its file name), or null
 * for a national document. The innermost state folder wins. */
export function stateOfPath(path: string): string | null {
  const folders = path.split('/').filter(Boolean).slice(0, -1)
  for (let i = folders.length - 1; i >= 0; i--) {
    const s = stateOfFolder(folders[i]!)
    if (s) return s
  }
  return null
}

/** The states that have documents, sorted, for the dropdown. */
export function statesOf(paths: string[]): string[] {
  return [...new Set(paths.map(stateOfPath).filter((s): s is string => s !== null))].sort()
}

/** What a search with `state` chosen covers: its documents and the national
 * ones. `preferred` marks the state's own. */
export function stateScope(paths: string[], state: string): { paths: string[]; preferred: Set<string> } {
  const preferred = new Set<string>()
  const allowed: string[] = []
  for (const p of paths) {
    const s = stateOfPath(p)
    if (s === state) preferred.add(p)
    if (s === null || s === state) allowed.push(p)
  }
  return { paths: allowed, preferred }
}
