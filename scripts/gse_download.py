#!/usr/bin/env python3
"""
gse_download.py — Download GSE Daily Shares & ETFs data from gse.com.gh.

Uses the `chrome-agent` CLI (Chrome DevTools Protocol) to drive a real Chrome
browser against https://gse.com.gh/trading-and-data/ and export the "Daily
Shares & ETFs" table for a given date or date range.

The table is a server-side wpDataTables instance (table_id=39). The site only
streams the rows for the currently selected date filter, so this script:
  1. launches/attaches a headless Chrome
  2. opens the trading page
  3. sets the "Daily Date" range filter to the requested date(s)
  4. sets the page length to "All" so every matching row is in the DOM
  5. reads the rendered table via Runtime.evaluate
  6. writes a CSV in the same format as the site's own "CSV" export button

Usage:
  python3 gse_download.py 21/08/2026
  python3 gse_download.py 21/08/2026 2026-08-21          # same date, two formats
  python3 gse_download.py 2026-08-01 2026-08-21          # date range
  python3 gse_download.py 21/08/2026 -o out.csv          # custom output file
  python3 gse_download.py 21/08/2026 --keep-browser       # don't stop chrome
  python3 gse_download.py 21/08/2026 --instance myname    # reuse a named instance

Dates are accepted as DD/MM/YYYY or YYYY-MM-DD. A single date means exactly
that trading day; two dates mean the inclusive range.

Requires: `chrome-agent` on PATH (see the chrome-agent skill), Python >= 3.8.
"""

from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
import time
from datetime import date, datetime, timedelta

# Site constants -----------------------------------------------------------
SITE_URL = "https://gse.com.gh/trading-and-data/"
TABLE_ID = "39"          # wpDataTables id of the "Daily Shares & ETFs" table
TABLE_DOM_ID = "table_1" # DOM id of that table
# Column header order in the site's CSV export (excludes the internal wdt_ID).
EXPORT_HEADERS = [
    "Daily Date",
    "Share Code",
    "Year High (GH¢)",
    "Year Low (GH¢)",
    "Previous Closing Price - VWAP (GH¢)",
    "Opening Price (GH¢)",
    "Last Transaction Price (GH¢)",
    "Closing Price - VWAP (GH¢)",
    "Price Change (GH¢)",
    "Closing Bid Price (GH¢)",
    "Closing Offer Price (GH¢)",
    "Total Shares Traded",
    "Total Value Traded (GH¢)",
]


# chrome-agent helpers ------------------------------------------------------
def run_chrome(args: list[str], timeout: int = 60) -> str:
    """Run a chrome-agent one-shot command and return its raw stdout."""
    proc = subprocess.run(
        ["chrome-agent", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"chrome-agent {' '.join(args)} failed:\n{proc.stderr.strip()}"
        )
    return proc.stdout.strip()


def run_js(instance: str, expression: str, timeout: int = 60) -> str:
    """Evaluate JavaScript in the page and return result.value (str) or ''."""
    out = run_chrome(
        [
            instance,
            "Runtime.evaluate",
            json.dumps({"expression": expression, "returnByValue": True}),
        ],
        timeout=timeout,
    )
    try:
        parsed = json.loads(out)
    except json.JSONDecodeError:
        return ""  # no result (e.g. transient context destroyed)
    result = parsed.get("result", {})
    if "value" in result:
        return result["value"]
    return ""  # .value is absent -> usually a Promise handle we didn't await


def wait_for(predicate, timeout: float = 30.0, interval: float = 0.5):
    """Poll until predicate() is truthy or timeout elapses."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def parse_date(value: str) -> date:
    """Parse DD/MM/YYYY or YYYY-MM-DD into a date."""
    value = value.strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    raise ValueError(
        f"Unrecognised date '{value}'. Use DD/MM/YYYY or YYYY-MM-DD."
    )


def fmt_dmY(d: date) -> str:
    """Site's date filter format: DD/MM/YYYY."""
    return d.strftime("%d/%m/%Y")


def default_date() -> date:
    """Most recent trading day (skip weekends) as a sensible default."""
    d = date.today()
    while d.weekday() >= 5:  # Sat=5, Sun=6
        d -= timedelta(days=1)
    return d


def drive_table(instance: str, from_d: date, to_d: date) -> list[list[str]]:
    """Set the date filter, load all rows, and return them as a list of lists.

    Returns only the visible export columns (no wdt_ID), matching the site's
    CSV export. Uses the same stated date format DD/MM/YYYY for from/to.
    """

    # 1. Set the "Daily Date" range filter through the datetimepicker so the
    #    blur handler (which requires oldDate != null) triggers a redraw.
    set_filter = r"""
    (function(){
      var set = function(id, value){
        var el = jQuery('#' + id);
        el.trigger('focus');                       // lazily init the picker
        el.datetimepicker('date', value);
        el.trigger('blur');                        // redraws the table
        return el.val();
      };
      var fromVal = set(%(from)s, new Date(%(fy)s, %(fm)s, %(fd)s));
      var toVal   = set(%(to)s,   new Date(%(ty)s, %(tm)s, %(td)s));
      return JSON.stringify({from: fromVal, to: toVal});
    })()
    """ % {
        "from": json.dumps(f"{TABLE_DOM_ID}_range_from_1"),
        "to": json.dumps(f"{TABLE_DOM_ID}_range_to_1"),
        "fy": from_d.year, "fm": from_d.month - 1, "fd": from_d.day,
        "ty": to_d.year, "tm": to_d.month - 1, "td": to_d.day,
    }
    run_js(instance, set_filter)

    # 2. Wait for the server-side filter to finish (recordsDisplay changes).
    wait_for(
        lambda: _records_display(instance) is not None,
        timeout=30,
    )

    # 3. Ask the table for every matching row (page length = -1 = "All").
    run_js(
        instance,
        f"jQuery('#{TABLE_DOM_ID}').DataTable().page.len(-1).draw(); 'ok'",
    )
    # Small settle for the extra page of data to arrive.
    time.sleep(1.0)

    # 4. Read the rendered grid. Grab <tr> cells in document order. The
    #    rendered table already omits the internal wdt_ID column, so each
    #    <td> row is exactly the 13 export columns (date .. total value),
    #    matching the site's own CSV export button.
    extract = r"""
    (function(){
      var rows = [];
      var trs  = document.querySelectorAll('#%(id)s tbody tr');
      for (var i = 0; i < trs.length; i++){
        var tds = trs[i].querySelectorAll('td');
        var row = [];
        for (var j = 0; j < tds.length; j++){
          row.push(tds[j].textContent.replace(/\s+/g, ' ').trim());
        }
        rows.push(row);
      }
      return JSON.stringify(rows);
    })()
    """ % {"id": TABLE_DOM_ID}
    raw = run_js(instance, extract)
    if not raw:
        raise RuntimeError("Could not read table rows from the page.")
    return json.loads(raw)


def _records_display(instance: str):
    """Return the number of records the current filter matches, or None."""
    out = run_js(
        instance,
        f"(function(){{var dt=jQuery('#{TABLE_DOM_ID}').DataTable();"
        f"return dt ? dt.page.info().recordsDisplay : null;}})()",
    )
    try:
        return int(out)
    except (TypeError, ValueError):
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Download GSE Daily Shares & ETFs data for a date/range."
    )
    parser.add_argument(
        "dates",
        nargs="*",
        help="One date (DD/MM/YYYY or YYYY-MM-DD) or two for an inclusive range. "
        "Omit to use the most recent weekday.",
    )
    parser.add_argument(
        "-o", "--output",
        help="Output CSV path (default: gse_daily_shares_<from>[_<to>].csv)",
    )
    parser.add_argument(
        "--instance", default=None,
        help="chrome-agent instance name to reuse (default: launch a new one).",
    )
    parser.add_argument(
        "--keep-browser", action="store_true",
        help="Do not stop the browser when done (for debugging).",
    )
    parser.add_argument(
        "--headful", action="store_true",
        help="Launch a visible (non-headless) browser window.",
    )
    args = parser.parse_args(argv)

    # Parse the date range ------------------------------------------------
    if len(args.dates) == 0:
        d = default_date()
        from_d = to_d = d
        print(
            f"[date] no date given; using most recent weekday {fmt_dmY(d)}",
            file=sys.stderr,
        )
    elif len(args.dates) == 1:
        d = parse_date(args.dates[0])
        from_d = to_d = d
    elif len(args.dates) == 2:
        from_d, to_d = parse_date(args.dates[0]), parse_date(args.dates[1])
        if to_d < from_d:
            from_d, to_d = to_d, from_d
    else:
        parser.error("Provide one date or two dates (inclusive range).")

    # Default output name ---------------------------------------------------
    if not args.output:
        stem = f"gse_daily_shares_{from_d.strftime('%Y-%m-%d')}"
        if to_d != from_d:
            stem += f"_{to_d.strftime('%Y-%m-%d')}"
        args.output = f"{stem}.csv"

    # Launch / attach Chrome ------------------------------------------------
    instance = args.instance
    if instance is None:
        launch_args = ["launch"]
        if not args.headful:
            launch_args.append("--headless")
        out = run_chrome(launch_args)
        instance = json.loads(out)["name"]
        print(f"[launch] browser instance '{instance}'", file=sys.stderr)
    else:
        print(f"[attach] reusing instance '{instance}'", file=sys.stderr)

    try:
        # Navigate and wait for the table -----------------------------------
        run_chrome([instance, "Page.navigate", json.dumps({"url": SITE_URL})])
        ok = wait_for(
            lambda: (run_js(instance, "document.readyState") == "complete"
                     and bool(run_js(
                         instance,
                         f"(function(){{var el=document.getElementById("
                         f"'{TABLE_DOM_ID}');return el?1:0;}})()",
                     ))),
            timeout=30,
        )
        if not ok:
            raise RuntimeError("Timed out waiting for the trading table.")

        # Fetch the rows for the requested date(s) --------------------------
        print(
            f"[fetch] date range {fmt_dmY(from_d)} .. {fmt_dmY(to_d)}",
            file=sys.stderr,
        )
        rows = drive_table(instance, from_d, to_d)
        print(f"[fetch] got {len(rows)} row(s)", file=sys.stderr)

        # Write the CSV (site's export format) ------------------------------
        with open(args.output, "w", newline="", encoding="utf-8") as fh:
            writer = csv.writer(fh, quoting=csv.QUOTE_ALL)
            writer.writerow(EXPORT_HEADERS)
            writer.writerows(rows)
        print(f"[done] wrote {args.output} ({len(rows)} rows)")
    finally:
        # Only stop a browser we launched ourselves (not one the caller
        # asked us to reuse via --instance), unless --keep-browser was set.
        if args.instance is None and not args.keep_browser:
            run_chrome(["stop", instance])
            print(f"[stop] stopped browser instance '{instance}'",
                  file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
