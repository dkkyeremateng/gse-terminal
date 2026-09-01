// Static reference data that rarely changes. Extracted from app.js so
// the monolith shrinks and these constants can be imported on demand.

// Company descriptions keyed by GSE ticker. Used by the About section
// and by the comparables sector-matching logic.
export const GSE_WIKI = {
    "ACCESS": "Access Bank Ghana Plc is a subsidiary of the pan-African Access Bank Group. It provides comprehensive commercial banking services, including corporate, retail, and treasury solutions, serving institutional, corporate, and individual customers across Ghana.",
    "ADB": "Agricultural Development Bank (ADB) is a universal bank that specializes in providing financial intermediation for the agricultural sector in Ghana. It offers a full range of banking services but maintains a strategic focus on financing the country's agribusiness development.",
    "EGH": "Ecobank Ghana PLC is a major subsidiary of Ecobank Transnational Inc. It delivers retail, corporate, and investment banking services across a vast network. It is consistently ranked among the top tiers of Ghanaian banks by both assets and market share.",
    "EGL": "Enterprise Group PLC is the oldest insurance company in Ghana (formerly Enterprise Insurance). It has transformed into a major financial services company with diversified interests in Life Insurance, General Insurance, Pensions, and Real Estate.",
    "BOPP": "Benso Oil Palm Plantation (BOPP) is a leading agro-industrial company in Ghana, primarily involved in the cultivation of oil palm and the processing of crude palm oil. It is a major player in the West African palm oil market.",
    "CAL": "CalBank PLC is a leading indigenous bank in Ghana, providing a broad range of banking and financial solutions to corporate, commercial, and individual customers. It is known for its focus on innovation and digital banking services.",
    "FML": "Fan Milk PLC is a leading manufacturer and retailer of ice cream and frozen dairy products in West Africa. It is a household name in Ghana, known for its high-quality frozen snacks and extensive vendor-based distribution network.",
    "TOTAL": "TotalEnergies Marketing Ghana PLC is a major player in the downstream petroleum industry. It markets and distributes petroleum products, lubricants, and renewable energy solutions through one of the largest retail networks in the country.",
    "GCB": "GCB Bank PLC is Ghana's oldest and largest indigenous bank. Established in 1953, it has evolved into a modern banking powerhouse with the country's most extensive branch network, providing diverse financial services tailored to the Ghanaian socio-economic climate.",
    "GOIL": "GOIL PLC (formerly Ghana Oil Company) is the leading marketing and distribution company for petroleum and energy products in Ghana. It maintains a dominant share of the retail fuel market through its vast network of 400+ stations.",
    "MTNGH": "Scancom PLC (MTN Ghana) is the leading mobile telecommunications provider in Ghana. Part of the South African MTN Group, it holds a near-monopoly on high-speed data and mobile financial services (MoMo), making it one of the most profitable entities on the GSE.",
    "SCB": "Standard Chartered Bank Ghana PLC is one of the oldest financial institutions in West Africa. It is a premium subsidiary of the UK-headquartered global bank, focusing on high-end corporate and retail banking with strong international trade links.",
    "TULLOW": "Tullow Oil PLC is a leading independent oil and gas exploration and production company. It is a major operator in Ghana's Jubilee and TEN oil fields, contributing significantly to the country's national oil revenue.",
    "UNIL": "Unilever Ghana PLC is a global leader in fast-moving consumer goods (FMCG). It manufactures and distributes iconic brands in home care, personal care, and food categories, and remains a benchmark for manufacturing excellence in Ghana.",
    "SOGEGH": "Societe Generale Ghana PLC is a leading universal bank that is part of the global Societe Generale group. It provides a wide array of financial products and services for corporate, SME, and retail clients.",
    "GLD": "NewGold ETF is an Exchange Traded Fund (ETF) that tracks the price of gold in Ghana Cedis. It allows investors a direct and convenient way to invest in physical gold bars without the costs and risks of physical handling and storage."
};

// 2026 GSE Market Holidays (GMT/UTC) — single source of truth used by
// updateMarketStatus() to decide if today is a trading day.
export const GHANA_HOLIDAYS = {
    "2026-01-01": "New Year's Day",
    "2026-01-07": "Constitution Day",
    "2026-03-06": "Independence Day",
    "2026-04-03": "Good Friday",
    "2026-04-06": "Easter Monday",
    "2026-05-01": "May Day",
    "2026-05-25": "Africa Day",
    "2026-07-01": "Republic Day",
    "2026-08-03": "Founders' Day",
    "2026-09-21": "Memorial Day",
    "2026-12-04": "Farmers' Day",
    "2026-12-25": "Christmas Day",
    "2026-12-26": "Boxing Day"
};

if (typeof window !== 'undefined') {
    window.GSE_WIKI = GSE_WIKI;
    window.GHANA_HOLIDAYS = GHANA_HOLIDAYS;
}
