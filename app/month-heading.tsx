import { monthLabel, todayBA } from "@/lib/agenda-dates";
import { toneClass } from "@/lib/palette";

// Month title shown once per month; its color is the month's logo tone (lib/palette.ts).
export default function MonthHeading({ day, sticky = false, loose = false }: { day: string; sticky?: boolean; loose?: boolean }) {
  return <h3 className={"month-head " + toneClass(day) + (sticky ? " sticky" : "") + (loose ? " loose" : "")}><span className="month-text">{monthLabel(day, todayBA())}</span></h3>;
}
