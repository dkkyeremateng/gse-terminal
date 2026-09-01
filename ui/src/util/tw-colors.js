// Static class lookup tables — Tailwind's JIT can only see literal
// class names in source. Anything built via `bg-${color}-500` is
// invisible to the scanner, so we map runtime values to full literal
// strings here. Every class the scanner needs to see appears below.

export const TW_COLORS = {
    emerald: {
        dotBg: 'bg-emerald-500',
        text500: 'text-emerald-500',
        text600: 'text-emerald-600',
        chipBg: 'bg-emerald-500/5',
        chipBorder: 'border-emerald-500/10',
        cardBorder: 'border-emerald-500/20',
        indicator: 'bg-emerald-500',
        soft: 'bg-emerald-500/10',
    },
    amber: {
        dotBg: 'bg-amber-500',
        text500: 'text-amber-500',
        text600: 'text-amber-600',
        chipBg: 'bg-amber-500/5',
        chipBorder: 'border-amber-500/10',
        cardBorder: 'border-amber-500/20',
        indicator: 'bg-amber-500',
        soft: 'bg-amber-500/10',
    },
    rose: {
        dotBg: 'bg-rose-500',
        text500: 'text-rose-500',
        text600: 'text-rose-600',
        chipBg: 'bg-rose-500/5',
        chipBorder: 'border-rose-500/10',
        cardBorder: 'border-rose-500/20',
        indicator: 'bg-rose-500',
        soft: 'bg-rose-500/10',
    },
    blue: {
        dotBg: 'bg-blue-500',
        text500: 'text-blue-500',
        text600: 'text-blue-600',
        chipBg: 'bg-blue-500/5',
        chipBorder: 'border-blue-500/10',
        cardBorder: 'border-blue-500/20',
        indicator: 'bg-blue-500',
        soft: 'bg-blue-500/10',
    },
    fuchsia: {
        dotBg: 'bg-fuchsia-500',
        text500: 'text-fuchsia-500',
        text600: 'text-fuchsia-600',
        chipBg: 'bg-fuchsia-500/5',
        chipBorder: 'border-fuchsia-500/10',
        cardBorder: 'border-fuchsia-500/20',
        indicator: 'bg-fuchsia-500',
        soft: 'bg-fuchsia-500/10',
    },
    red: {
        dotBg: 'bg-red-500',
        text500: 'text-red-500',
        text600: 'text-red-600',
        chipBg: 'bg-red-500/5',
        chipBorder: 'border-red-500/10',
        cardBorder: 'border-red-500/20',
        indicator: 'bg-red-500',
        soft: 'bg-red-500/10',
    },
};

export const twColor = (name) => TW_COLORS[name] || TW_COLORS.blue;
