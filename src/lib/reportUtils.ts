/**
 * Report date and filtering utilities for frontend collection reports.
 */

export type ReportFilterType = "daily" | "monthly" | "custom" | "all";
export type ReportTabType = "teachers" | "batches" | "students" | "handovers";

/**
 * Returns current date in IST (Asia/Kolkata UTC+5:30) as YYYY-MM-DD
 */
export function getTodayIST(testDate: Date = new Date()): string {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(testDate.getTime() + (testDate.getTimezoneOffset() * 60000) + istOffset);
  return istDate.toISOString().slice(0, 10);
}

/**
 * Returns yesterday's date in IST as YYYY-MM-DD
 */
export function getYesterdayIST(testDate: Date = new Date()): string {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(testDate.getTime() + (testDate.getTimezoneOffset() * 60000) + istOffset - (24 * 60 * 60 * 1000));
  return istDate.toISOString().slice(0, 10);
}

/**
 * Returns current month in IST as YYYY-MM
 */
export function getCurrentMonthIST(testDate: Date = new Date()): string {
  return getTodayIST(testDate).slice(0, 7);
}

/**
 * Returns start of current month in IST as YYYY-MM-01
 */
export function getMonthStartIST(testDate: Date = new Date()): string {
  return `${getCurrentMonthIST(testDate)}-01`;
}
