// Bylaws search test pack: 81 questions, answers checked by hand against the
// bylaws text. BL = 202504161857302632Bylaws_160425.pdf in trijya_bylaws_e5.
//
// A case passes when one of its first `top` results matches one of `expect`:
// `file` is tested against the file name, `row` against matchedRow (or the
// excerpt when a result has no row), with dashes and spaces normalised.
// `none`: the search must return nothing. `review`: no fixed answer, the
// results are printed to be read by eye.
//
// Batch 1 (41) was written first and the matcher was fixed against it.
// Batch 2 (27) was written afterwards and run once before further changes.
// Batch 3 (13) is messy phrasing. See docs/RAG_CHANGES_OCT_2026.md.
const BL = /Bylaws_160425/

export const CASES = [
  // ---- batch 1
  // --- Residential setbacks, 3.2.4.1 (row housing / semi-detached / detached)
  { id: 'set-res-200', q: 'setback for 200 sq m residential plot', top: 1, expect: [{ file: BL, row: />150 to 300 3 1\.5 0 0/ }] },
  { id: 'set-plot-200', q: 'find setback rules for 200sq meter plot?', top: 1, expect: [{ file: BL, row: />150 to 300 3 1\.5 0 0/ }] },
  { id: 'set-res-500', q: 'setback required for a 500 square metre residential plot', top: 1, expect: [{ file: BL, row: />300 to 500 3 3 0 0/ }] },
  { id: 'set-res-1000', q: 'front setback for 1000 sqm residential plot', top: 1, expect: [{ file: BL, row: />500 to 1200 4\.5 4\.5 1\.5 0/ }] },
  { id: 'set-res-100', q: 'setback for a house on 100 sq m plot', top: 1, expect: [{ file: BL, row: /up to 150 1 0 0 0/i }] },
  { id: 'set-res-1500', q: 'setback for detached house on 1500 sq m plot', top: 1, expect: [{ file: BL, row: />1200 6 6 1\.5 1\.5/ }] },
  { id: 'set-res-300', q: 'rear setback for 300 sqm plot residential', top: 1, expect: [{ file: BL, row: />150 to 300 3 1\.5 0 0/ }] },
  { id: 'set-sqft', q: 'setback for 2000 sq ft residential plot', top: 1, expect: [{ file: BL, row: />150 to 300 3 1\.5 0 0/ }] },
  { id: 'set-gaj', q: 'setback for 150 gaj plot', top: 1, expect: [{ file: BL, row: /up to 150 1 0 0 0/i }] },
  // --- Other uses, 3.2.4.3 - 3.2.4.8
  { id: 'set-com-250', q: 'setback for commercial plot of 250 sq m', top: 1, expect: [{ file: BL, row: />100 - 300 3 - - -/ }] },
  { id: 'set-shop-2000', q: 'setbacks for a shop on 2000 sqm plot', top: 1, expect: [{ file: BL, row: />1000 - 3000 6 3 3 3/ }] },
  { id: 'set-hosp-1500', q: 'setback for a hospital on 1500 sqm plot', top: 1, expect: [{ file: BL, row: />1000 - 2000 6 3 3 3/ }] },
  { id: 'set-school-3000', q: 'school building setback on 3000 sq m plot', top: 1, expect: [{ file: BL, row: />2000 - 4000 9 3 3 3/ }] },
  { id: 'set-ind-400', q: 'industrial building setback for 400 sqm plot', top: 1, expect: [{ file: BL, row: />300 - 500 4\.5 3 3 0/ }] },
  { id: 'set-gh', q: 'setback for group housing up to 15 m height', top: 2, expect: [{ file: BL, row: /up to 15-?\s?meters 5 5 5 5/i }] },
  // --- Height-based setbacks, 3.2.4.9
  { id: 'set-h20', q: 'setback for a 20 m high building', top: 1, expect: [{ file: BL, row: />17\.5 - 21 6 6 6 6/ }] },
  { id: 'set-h40', q: 'setbacks for building height 40 meters', top: 1, expect: [{ file: BL, row: />39 - 45 10 10 10 10/ }] },
  // --- FAR, 3.2.2.x
  { id: 'far-2000', q: 'FAR for 2000 sq m plot', top: 1, expect: [{ file: BL, row: />1200 1\.25 2\.0/ }] },
  { id: 'far-250', q: 'FAR for 250 sqm residential plot', top: 1, expect: [{ file: BL, row: />150 (to|-) 300 1\.8 2\.0/ }] },
  { id: 'far-100', q: 'maximum FAR for a 100 sq m plot', top: 1, expect: [{ file: BL, row: /(up to|≥40 -) 150 2\.00? 2\.0/i }] },
  { id: 'far-shop-18', q: 'FAR for shops on an 18 m road', top: 1, expect: [{ file: BL, row: />12 - 24 ?m 1\.5 3/ }] },
  { id: 'far-gh-30', q: 'FAR for group housing on 30 m wide road', top: 1, expect: [{ file: BL, row: />24 - 45 ?m (1\.5 5\.25|2\.5 8\.75)/ }] },
  { id: 'far-school-10', q: 'FAR for a primary school on 10 m road', top: 1, expect: [{ file: BL, row: /up to 12 ?m 1\.(0|2) 1\.4/i }] },
  { id: 'cov-400', q: 'ground coverage for 400 sq m residential plot', top: 1, expect: [{ file: BL, row: />300 to 500/ }] },
  // --- Parking
  { id: 'park-120', q: 'parking requirement for a 120 sq m flat', top: 2, expect: [{ file: BL, row: />100 - 150 1\.25/ }] },
  { id: 'park-mall', q: 'parking for a shopping mall', top: 3, expect: [{ file: BL, row: /shopping mall 3 \/ 100 sqm/i }] },
  { id: 'park-hosp', q: 'parking requirement for hospital', top: 3, expect: [{ file: BL, row: /1\.5 (ECS )?(\/|per) 125 sqm/i }] },
  { id: 'park-ecs-base', q: 'area of one ECS in basement parking', top: 3, expect: [{ file: BL, row: /basement 32 square meters/i }] },
  // --- Height, staircase, other
  { id: 'height-single', q: 'maximum height of a plotted single unit house', top: 3, expect: [{ file: BL, row: /plotted - single-unit 15/i }, { file: BL, row: /three floors with stilts up to 15 meter/i }] },
  { id: 'stair-res', q: 'minimum width of staircase in residential buildings', top: 3, expect: [{ file: /NBC_MBBL/, row: /residential buildings \(dwellings\) 1\.0 ?m/i }, { file: BL, row: /1\.0 meter in residential buildings/i }] },
  { id: 'vent-20', q: 'ventilation shaft size for a 20 m high building', top: 2, expect: [{ file: BL, row: /up to 24 5\.4 1\.8/i }] },
  { id: 'base-1500', q: 'how many basements are allowed on a 1500 sq m plot', top: 2, expect: [{ file: BL, row: /1000 ?- ?2000 sq\.?m\.? - 2 basements/i }] },
  { id: 'road-gh', q: 'minimum road width for group housing', top: 3, expect: [{ file: BL, row: /group housing shall be located on road of minimum 12-meter/i }, { file: BL, row: /group housing projects, the minimum width of access road shall be 12 ?m/i }, { file: BL, row: /group housing 1000 \(built-up\) 1500 \(non-built-up\) 9 \(built-up area\) 12/i }] },
  { id: 'fire-hr', q: 'fire exit requirements for high rise buildings', top: 3, expect: [{ file: /NBC|Booklet/, row: /fire/i }] },
  { id: 'junk', q: 'what is a banana spaceship', none: true },
  { id: 'junk2', q: 'best biryani recipe', none: true },
  // --- Hindi
  { id: 'hi-set-200', q: '200 वर्ग मीटर आवासीय भूखंड का सेटबैक कितना होगा', top: 2, expect: [{ file: BL, row: />150 to 300 3 1\.5 0 0/ }, { file: /Compiled/, row: /सेट ?बैक/ }] },
  { id: 'hi-height', q: 'भवन की अधिकतम ऊंचाई कितनी हो सकती है', top: 3, expect: [{ file: /Compiled|Bylaws|G-O/, row: /ऊँचाई|ऊंचाई|height/i }] },
  { id: 'hi-park', q: 'पार्किंग के लिए कितनी जगह छोड़नी होगी', top: 3, expect: [{ file: /Compiled/, row: /पार्किंग|पाकिंग/ }] },
  { id: 'hi-far-gh', q: 'ग्रुप हाउसिंग के लिए एफ.ए.आर. कितना है', top: 3, expect: [{ file: /Compiled|Bylaws/, row: /(एफ|FAR)/ }] },
  { id: 'hi-school', q: 'स्कूल के लिए 2000 वर्गमीटर भूखंड पर सेट बैक', top: 2, expect: [{ file: BL, row: />1000 - 2000 6 3 3 3/ }, { file: /Compiled/, row: /1001 से 3000 तक/ }] },
  // ---- batch 2 (held out)
  { id: 'b2-set-semi-700', q: 'rear setback for 700 sq m semi-detached house', top: 1, expect: [{ file: BL, row: />500 to 1200 4\.5 4\.5 1\.5 0/ }] },
  { id: 'b2-set-row-120', q: 'setback for a row house on 120 sqm', top: 1, expect: [{ file: BL, row: /up to 150 1 0 0 0/i }] },
  { id: 'b2-set-ind-5000', q: 'setback for 5000 sqm industrial plot', top: 1, expect: [{ file: BL, row: />2000 - 6000 7\.5 6 4\.5 4\.5/ }] },
  { id: 'b2-set-h25', q: 'setback for a 25 m tall building', top: 1, expect: [{ file: BL, row: />21 - 27 7 7 7 7/ }] },
  { id: 'b2-set-h55', q: 'what setback is needed for a building of height 55 m', top: 1, expect: [{ file: BL, row: />51 15 12 12 12/ }] },
  { id: 'b2-far-600', q: 'FAR for 600 sqm plot', top: 1, expect: [{ file: BL, row: />500 (to|-) ?1200 1\.50? 2\.0/ }] },
  { id: 'b2-far-1200', q: 'permissible FAR on a 1200 sq m plot', top: 1, expect: [{ file: BL, row: />500 (to|-) ?1200 1\.50? 2\.0/ }] },
  { id: 'b2-far-hosp-20', q: 'FAR for a hospital on 20 m road', top: 1, expect: [{ file: BL, row: /(=?>)1[28] - 24 ?m 1\.5 3(\.0)?/ }] },
  { id: 'b2-far-ind-30', q: 'FAR for industrial building on 30 m road', top: 1, expect: [{ file: BL, row: />24 - 45 ?m 2\.5 8\.75/ }] },
  { id: 'b2-park-gh-80', q: 'parking for an 80 sq m flat in group housing', top: 1, expect: [{ file: BL, row: />50 - 100 1\.00/ }] },
  { id: 'b2-park-office', q: 'parking requirement for office building', top: 2, expect: [{ file: BL, row: /office buildings 2\.0 per 100 sqm/i }] },
  { id: 'b2-park-ind', q: 'parking for industrial building', top: 2, expect: [{ file: BL, row: /industrial buildings 1 per 300 sqm/i }] },
  { id: 'b2-park-marriage', q: 'parking for marriage hall', top: 2, expect: [{ file: BL, row: /marriage hall.{0,60}2 \/ 100 sqm/i }, { file: /G-O-07|Tourism/, row: /2\.00 ecs per 100 sq/i }] },
  { id: 'b2-height-gh', q: 'maximum height allowed for group housing', top: 3, expect: [{ file: BL, row: /group housing no restriction/i }, { file: BL, row: /no restriction on the maximum permissible building height for group housing/i }] },
  { id: 'b2-vent-12', q: 'ventilation shaft for a 12 m high building', top: 1, expect: [{ file: BL, row: /up to 15 1\.2 0\.9/i }] },
  { id: 'b2-set-petrol', q: 'setback for petrol pump', top: 2, expect: [{ file: BL, row: /petrol filling station w\/o service station 3/i }, { file: BL, row: /petrol pump\/ filling station.*3-m/i }] },
  { id: 'b2-base-2500', q: 'how many basements allowed on 2500 sqm plot', top: 2, expect: [{ file: BL, row: />2000 sq\.?m\.? - 3 basements/i }] },
  { id: 'b2-hi-sqft', q: '2000 वर्ग फुट प्लॉट पर सेटबैक', top: 1, expect: [{ file: BL, row: />150 to 300 3 1\.5 0 0/ }] },
  { id: 'b2-set-50', q: 'setback for 50 sqm plot', top: 1, expect: [{ file: BL, row: /up to 150 1 0 0 0/i }] },
  { id: 'b2-set-edu-10000', q: 'setback for 10000 sqm school', top: 1, expect: [{ file: BL, row: />4000 - 30000 9 4\.5 3 3/ }] },
  { id: 'b2-junk3', q: 'who won the cricket world cup', none: true },
  { id: 'b2-junk4', q: 'how to cook pasta', none: true },
  { id: 'b2-hi-far-500', q: '500 वर्ग मीटर प्लॉट का एफएआर', top: 1, expect: [{ file: BL, row: />300 (to|-) 500 1\.75 2\.0/ }] },
  { id: 'b2-cov-gh', q: 'ground coverage for group housing', top: 3, expect: [{ file: BL, row: /coverage/i }] },
  { id: 'b2-stair-gh', q: 'minimum staircase width in group housing above three storeys', top: 3, expect: [{ file: BL, row: /group housing buildings more than three storeys high shall be 1\.5 met/i }] },
  { id: 'b2-set-com-5000', q: 'setback for commercial plot 5000 sqm', top: 1, expect: [{ file: BL, row: />3000 12 6 6 6/ }] },
  { id: 'b2-set-range', q: 'setback for a residential plot between 250 and 300 sqm', top: 1, expect: [{ file: BL, row: />150 to 300 3 1\.5 0 0/ }] },
  // ---- batch 3 (read by eye)
  ...[
    'minimum front and side setback for plot size 180 sqm',
    'setbac for 200 sqm plot',
    'far 2000 sqm',
    'setback 1500 sq.m. plot',
    'plot area 300 sqm setback',
    'setback for 0.5 acre plot',
    'what is the FAR for a hospital on a 2000 sq m plot',
    'parking for 200 sqm shop',
    'ग्रुप हाउसिंग 30 मीटर सड़क एफएआर',
    'basement allowed in 800 sq m residential plot',
    'setback for 200 sq m plot in hilly area',
    'how much ground coverage on 150 sq m plot',
    'height limit for building on 12 m road',
  ].map((q, i) => ({ id: `r3-${i}`, q, review: true })),
]
