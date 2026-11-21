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
  ['Dadra and Nagar Haveli and Daman and Diu', /dadra|\bdaman\b/], // not "andaman"
  ['Lakshadweep', /lakshadweep/],
  ['Andaman and Nicobar Islands', /andaman|nicobar/],
]

/**
 * BIS "Standardized Development and Building Regulations, 2023" (SP 73): a
 * model based on the NBC that BIS offers each state to adopt, one copy per
 * state with only the cover changed. Not the bylaws in force: a state's own
 * bylaws (MDDA, ...) always rank above it, and answers say it is a model.
 */
const BIS_MODEL = /standardi[sz]ed[\s_-]*development[\s_-]*(?:and|&)[\s_-]*building[\s_-]*regulations|(?<![a-z])sp[\s_-]*73(?:[\s_:-]*2023|(?!\d))/i

/** A BIS model regulation (any state's copy, or the national master). */
export function isModelRegulation(pathOrName: string): boolean {
  return BIS_MODEL.test(pathOrName)
}

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

/**
 * What a search with `state` chosen covers: its documents and the national
 * ones. `preferred` marks the state's own bylaws, ranked first; its copy of
 * the BIS model is searched but not preferred. The national BIS master is
 * left out when the state has its own copy (the same text twice).
 */
export function stateScope(paths: string[], state: string): { paths: string[]; preferred: Set<string> } {
  const preferred = new Set<string>()
  const allowed: string[] = []
  const ownModel = paths.some((p) => stateOfPath(p) === state && isModelRegulation(p))
  for (const p of paths) {
    const s = stateOfPath(p)
    const model = isModelRegulation(p)
    if (s === state && !model) preferred.add(p)
    if (s === state || (s === null && !(model && ownModel))) allowed.push(p)
  }
  return { paths: allowed, preferred }
}

/**
 * With no state chosen: every document except the per-state copies of the
 * BIS model, which hold the same text 36 times over and would fill every
 * result list with one passage. The national master stands for them; with
 * no master, the first state copy does. Null when nothing is left out (no
 * filter needed).
 */
export function allStatesScope(paths: string[]): { paths: string[]; preferred: Set<string> } | null {
  const copies = paths.filter((p) => isModelRegulation(p) && stateOfPath(p) !== null).sort()
  if (copies.length <= 1) return null
  const hasMaster = paths.some((p) => isModelRegulation(p) && stateOfPath(p) === null)
  const drop = new Set(hasMaster ? copies : copies.slice(1))
  return { paths: paths.filter((p) => !drop.has(p)), preferred: new Set() }
}
