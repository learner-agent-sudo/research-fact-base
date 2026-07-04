/**
 * Canadian neutral-citation court codes → CanLII `databaseId`.
 *
 * Neutral citations look like `2019 SCC 65` (year, court code, decision number).
 * CanLII's API addresses cases as caseBrowse/{lang}/{databaseId}/{caseId}, where
 * caseId is `{year}{court-lowercased}{number}` (e.g. `2019scc65`). Federal courts
 * use bilingual databaseIds (csc-scc); provincial courts usually use the plain
 * lowercased code (onca, bcca). Verify/extend against CanLII's database list; the
 * verifier degrades to "unverified" on a 404 rather than failing.
 */
export const COURT_DB: Record<string, string> = {
  // Federal
  SCC: "csc-scc",
  FCA: "fca-caf",
  FC: "fct-cf",
  TCC: "tcc-cci",
  CMAC: "cmac-cacm",
  // Ontario
  ONCA: "onca",
  ONSC: "onsc",
  ONCJ: "oncj",
  // British Columbia
  BCCA: "bcca",
  BCSC: "bcsc",
  BCPC: "bcpc",
  // Alberta
  ABCA: "abca",
  ABKB: "abkb",
  ABQB: "abqb",
  ABPC: "abpc",
  // Saskatchewan
  SKCA: "skca",
  SKKB: "skkb",
  SKQB: "skqb",
  // Manitoba
  MBCA: "mbca",
  MBKB: "mbkb",
  MBQB: "mbqb",
  // Quebec
  QCCA: "qcca",
  QCCS: "qccs",
  QCCQ: "qccq",
  // Nova Scotia
  NSCA: "nsca",
  NSSC: "nssc",
  NSPC: "nspc",
  // New Brunswick
  NBCA: "nbca",
  NBKB: "nbkb",
  NBQB: "nbqb",
  // Newfoundland & Labrador
  NLCA: "nlca",
  NLSC: "nlsc",
  // PEI / Territories
  PECA: "peca",
  PESC: "pesc",
  YKCA: "ykca",
  YKSC: "yksc",
  NUCA: "nuca",
  NUCJ: "nucj",
};

export const CA_COURT_CODES = new Set(Object.keys(COURT_DB));
