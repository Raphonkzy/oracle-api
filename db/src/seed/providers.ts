import type { AccountType } from "@oracle/core";

export type ProviderGroup =
  | "bank_bumn"
  | "bank_swasta"
  | "bank_digital"
  | "bank_syariah"
  | "bank_daerah"
  | "ewallet"
  | "emoney"
  | "paylater"
  | "investment"
  | "other";

export type ProviderSeed = {
  id: string;
  name: string;
  type: AccountType;
  group: ProviderGroup;
  /** App names and other spellings, used for search. */
  aliases?: string[];
  /** Brand color (approximate), used for the initials badge. */
  color: string;
};

export const PROVIDER_GROUP_LABELS: Record<ProviderGroup, string> = {
  bank_bumn: "State-owned Banks",
  bank_swasta: "Private Banks",
  bank_digital: "Digital Banks",
  bank_syariah: "Sharia Banks",
  bank_daerah: "Regional Banks",
  ewallet: "E-Wallet",
  emoney: "E-Money Cards",
  paylater: "Paylater & Credit Cards",
  investment: "Investments",
  other: "Other",
};

const bank = (
  group: ProviderGroup,
  id: string,
  name: string,
  color: string,
  aliases?: string[],
): ProviderSeed => ({ id, name, type: "bank", group, color, aliases });

/** Brand names change with mergers and rebrands; review this list periodically. */
export const PROVIDERS: ProviderSeed[] = [
  bank("bank_bumn", "mandiri", "Bank Mandiri", "#003D79", ["Livin", "Livin' by Mandiri"]),
  bank("bank_bumn", "bri", "BRI", "#00529C", ["BRImo", "Bank Rakyat Indonesia"]),
  bank("bank_bumn", "bni", "BNI", "#F15A23", ["wondr", "wondr by BNI", "Bank Negara Indonesia"]),
  bank("bank_bumn", "btn", "BTN", "#1B4E9B", ["Bale by BTN", "Bank Tabungan Negara"]),

  bank("bank_swasta", "bca", "BCA", "#005DAA", ["myBCA", "BCA mobile", "KlikBCA", "Bank Central Asia"]),
  bank("bank_swasta", "cimb-niaga", "CIMB Niaga", "#7A0019", ["OCTO", "OCTO Mobile"]),
  bank("bank_swasta", "permata", "PermataBank", "#00843D", ["PermataMobile X"]),
  bank("bank_swasta", "danamon", "Bank Danamon", "#F7941D", ["D-Bank PRO"]),
  bank("bank_swasta", "ocbc", "OCBC", "#E30613", ["OCBC NISP", "OCBC mobile"]),
  bank("bank_swasta", "maybank", "Maybank Indonesia", "#FFC72C", ["M2U", "Maybank2u"]),
  bank("bank_swasta", "panin", "Panin Bank", "#0067B1"),
  bank("bank_swasta", "smbc", "SMBC Indonesia", "#00843D", ["BTPN"]),
  bank("bank_swasta", "uob", "UOB Indonesia", "#0B3B8C"),
  bank("bank_swasta", "hsbc", "HSBC Indonesia", "#DB0011"),
  bank("bank_swasta", "mega", "Bank Mega", "#F58220", ["M-Smile"]),
  bank("bank_swasta", "sinarmas", "Bank Sinarmas", "#E31E24", ["SimobiPlus"]),
  bank("bank_swasta", "kb-bank", "KB Bank", "#FFB81C", ["KB Bukopin", "Bukopin"]),
  bank("bank_swasta", "mayapada", "Bank Mayapada", "#00539B"),
  bank("bank_swasta", "nobu", "Nobu Bank", "#00A0DF"),
  bank("bank_swasta", "mnc-bank", "MNC Bank", "#E31E24", ["MotionBanking"]),

  bank("bank_digital", "jago", "Bank Jago", "#FDB813", ["Jago"]),
  bank("bank_digital", "seabank", "SeaBank", "#EE4D2D"),
  bank("bank_digital", "blu", "blu by BCA Digital", "#00B2E3", ["blu", "BCA Digital"]),
  bank("bank_digital", "jenius", "Jenius", "#00A0DF"),
  bank("bank_digital", "allo", "Allo Bank", "#1D1D1B"),
  bank("bank_digital", "neo", "Bank Neo Commerce", "#FF6D00", ["neobank", "BNC"]),
  bank("bank_digital", "superbank", "Superbank", "#6C2BD9"),
  bank("bank_digital", "krom", "Krom Bank", "#111111", ["Krom"]),
  bank("bank_digital", "hibank", "Hibank", "#0066B3"),
  bank("bank_digital", "raya", "Bank Raya", "#00A5E3", ["Raya"]),
  bank("bank_digital", "line-bank", "LINE Bank", "#06C755", ["Hana Bank"]),
  bank("bank_digital", "tmrw", "TMRW by UOB", "#0B3B8C", ["TMRW"]),
  bank("bank_digital", "digibank", "digibank by DBS", "#E1261C", ["DBS"]),
  bank("bank_digital", "saqu", "Bank Saqu", "#0057B8", ["Saqu"]),
  bank("bank_digital", "senyumku", "Senyumku", "#00A99D", ["Amar Bank"]),

  bank("bank_syariah", "bsi", "BSI", "#00A39D", ["BYOND", "BYOND by BSI", "BSI Mobile", "Bank Syariah Indonesia"]),
  bank("bank_syariah", "muamalat", "Bank Muamalat", "#5B2C83", ["Muamalat DIN"]),
  bank("bank_syariah", "bca-syariah", "BCA Syariah", "#008C45"),
  bank("bank_syariah", "mega-syariah", "Bank Mega Syariah", "#F58220"),
  bank("bank_syariah", "aladin", "Bank Aladin Syariah", "#7B2CBF", ["Aladin"]),
  bank("bank_syariah", "btn-syariah", "BTN Syariah", "#1B4E9B"),

  bank("bank_daerah", "bank-dki", "Bank DKI", "#E31E24", ["JakOne Mobile", "Bank Jakarta"]),
  bank("bank_daerah", "bjb", "bank bjb", "#005BAA", ["DIGI by bjb"]),
  bank("bank_daerah", "bank-jateng", "Bank Jateng", "#E31E24"),
  bank("bank_daerah", "bank-jatim", "Bank Jatim", "#E31E24", ["JConnect"]),
  bank("bank_daerah", "bpd-diy", "BPD DIY", "#00843D", ["Bank BPD DIY"]),
  bank("bank_daerah", "bpd-bali", "BPD Bali", "#E31E24", ["Bank BPD Bali"]),
  bank("bank_daerah", "bank-sumut", "Bank Sumut", "#E31E24"),
  bank("bank_daerah", "bank-nagari", "Bank Nagari", "#00843D"),
  bank("bank_daerah", "bank-sumsel-babel", "Bank Sumsel Babel", "#E31E24"),
  bank("bank_daerah", "bank-kalbar", "Bank Kalbar", "#005BAA"),
  bank("bank_daerah", "bank-kaltimtara", "Bank Kaltimtara", "#005BAA"),
  bank("bank_daerah", "bank-sulselbar", "Bank Sulselbar", "#005BAA"),
  bank("bank_daerah", "bank-aceh", "Bank Aceh Syariah", "#00843D"),
  bank("bank_daerah", "bank-ntb", "Bank NTB Syariah", "#00843D"),
  bank("bank_daerah", "brk-syariah", "Bank Riau Kepri Syariah", "#00843D", ["BRK Syariah"]),
  bank("bank_daerah", "bank-papua", "Bank Papua", "#005BAA"),

  { id: "gopay", name: "GoPay", type: "ewallet", group: "ewallet", color: "#00AED6", aliases: ["Gojek"] },
  { id: "ovo", name: "OVO", type: "ewallet", group: "ewallet", color: "#4C3494" },
  { id: "dana", name: "DANA", type: "ewallet", group: "ewallet", color: "#108EE9" },
  { id: "shopeepay", name: "ShopeePay", type: "ewallet", group: "ewallet", color: "#EE4D2D", aliases: ["Shopee"] },
  { id: "linkaja", name: "LinkAja", type: "ewallet", group: "ewallet", color: "#E82529" },
  { id: "astrapay", name: "AstraPay", type: "ewallet", group: "ewallet", color: "#0057B8" },
  { id: "isaku", name: "i.saku", type: "ewallet", group: "ewallet", color: "#E31E24", aliases: ["isaku", "Indomaret"] },
  { id: "doku", name: "DOKU", type: "ewallet", group: "ewallet", color: "#E1251B" },

  { id: "flazz", name: "Flazz BCA", type: "emoney", group: "emoney", color: "#005DAA", aliases: ["Flazz"] },
  { id: "emoney-mandiri", name: "e-money Mandiri", type: "emoney", group: "emoney", color: "#003D79", aliases: ["emoney"] },
  { id: "brizzi", name: "Brizzi BRI", type: "emoney", group: "emoney", color: "#00529C", aliases: ["Brizzi"] },
  { id: "tapcash", name: "TapCash BNI", type: "emoney", group: "emoney", color: "#F15A23", aliases: ["TapCash"] },

  { id: "gopaylater", name: "GoPayLater", type: "paylater", group: "paylater", color: "#00AED6" },
  { id: "spaylater", name: "SPayLater", type: "paylater", group: "paylater", color: "#EE4D2D", aliases: ["Shopee PayLater"] },
  { id: "kredivo", name: "Kredivo", type: "paylater", group: "paylater", color: "#FF6600" },
  { id: "akulaku", name: "Akulaku", type: "paylater", group: "paylater", color: "#E31E24" },
  { id: "atome", name: "Atome", type: "paylater", group: "paylater", color: "#F0FF5F" },
  { id: "indodana", name: "Indodana", type: "paylater", group: "paylater", color: "#00A99D" },
  { id: "credit-card", name: "Kartu Kredit", type: "credit_card", group: "paylater", color: "#334155", aliases: ["Credit Card", "CC"] },

  { id: "bibit", name: "Bibit", type: "investment", group: "investment", color: "#00AA5B" },
  { id: "ajaib", name: "Ajaib", type: "investment", group: "investment", color: "#4C3FE4" },
  { id: "stockbit", name: "Stockbit", type: "investment", group: "investment", color: "#00A884" },
  { id: "pluang", name: "Pluang", type: "investment", group: "investment", color: "#1A73E8" },
  { id: "bareksa", name: "Bareksa", type: "investment", group: "investment", color: "#00A0DF" },
  { id: "ipot", name: "IPOT", type: "investment", group: "investment", color: "#E31E24", aliases: ["Indo Premier"] },
  { id: "pintu", name: "Pintu", type: "investment", group: "investment", color: "#0A68F4" },
  { id: "indodax", name: "Indodax", type: "investment", group: "investment", color: "#0E2D5C" },
  { id: "tokocrypto", name: "Tokocrypto", type: "investment", group: "investment", color: "#1E2329" },
  { id: "pegadaian-emas", name: "Tabungan Emas Pegadaian", type: "investment", group: "investment", color: "#00843D", aliases: ["Pegadaian", "Emas"] },

  { id: "cash", name: "Cash", type: "cash", group: "other", color: "#16A34A", aliases: ["Tunai", "Dompet", "Wallet"] },
];
