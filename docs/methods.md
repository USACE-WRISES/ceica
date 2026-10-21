# CEICA methods

How CEICA turns inputs into cost-effectiveness and incremental cost analysis (CE/ICA) results,
and where each rule comes from. Every rule here follows IWR Planning Suite II (the certified USACE
tool) unless a section says otherwise, and is described by how that tool behaves. The tests named
at the end of each section (in `web/tests`) check the rule.

## 1. Outputs

A project's output is built from one or more **modules**: named parts that add up to the total,
such as Utoy's riparian left bank, riparian right bank and instream, or a single "Habitat" module
in a simple study. Each module has a **method**, how its values are entered:

| Method | Entered for each alternative | Module output at a target year |
|---|---|---|
| Habitat units | Habitat units at each target year | As entered |
| Index x quantity | An index (0 to 1) and a quantity at each target year | Index times quantity |
| STAF function scores | 20 function scores (0 to 15) and a quantity at each target year | ECI times quantity (section 8) |
| Average annual value | The module's average annual output, directly | (no yearly values) |

Habitat unit, index x quantity and average annual modules mix freely. A study that uses STAF uses
only STAF modules (one or more), since condition units and habitat units are not the same measure.
Modules add up, so they must all measure the same thing.

**Totals.** Each module is averaged over the period on its own (an average annual module is
already an average). An alternative's **total** is the sum of its modules' averages. With
straight lines between target years the average is linear, so this equals the average of the
summed yearly outputs; the IWR Annualizer option rounds each module's yearly values first.

**Average annual output.** The output is averaged over the period of analysis by straight lines
between target years: the area under the lines divided by the span of the target years (the
trapezoid rule of ecorest `annualizer`). The option "IWR Annualizer" fills every integer year
from 0 to the period of analysis, interpolating between target years and rounding interpolated
years to 2 decimals (half to even), and averages those, as IWR Planning Suite II's annualizer
does.

**Lift** is the total minus the site's No Action total, and each module's lift is its average
minus No Action's for that module; the module lifts add up to the lift. No Action's lift is 0.

Tests: `annualize.test.ts`, `utoy.test.ts`.

## 2. Costs

**First costs** (construction, monitoring, adaptive management and any added category) are
base-year dollars.

**Interest during construction (IDC)** applies to the categories marked for it (construction by
default), spent evenly over the construction months:

    IDC = P / M x (lead x ((1 + a)^M - 1) / a - M),   a = (1 + r)^(1/12) - 1

where P is the first cost, M the months and r the discount rate. `lead` is 1 when spending falls
at the end of each month (the default, as in the Utoy analysis), 1 + a at the start, and
1 + a/2 at the middle (IWR's half period). For whole months the per-month sum is used, as IWR
Planning Suite II's annualizer computes IDC.

**OMRRR** items recur every N years from a first year (default N) through a last year (default
the period of analysis). An item is a fixed amount, a percent of a first-cost category, or a
unit rate times a quantity. Its present value is the sum over occurrences of the amount times
(1 + r)^-t for occurrence year t (end of year, the default), or (1 + r)^-(t - 1/2) (mid-year,
as IWR Planning Suite II discounts).

**Average annual cost** = CRF x (first costs + IDC + present value of OMRRR), with the capital
recovery factor CRF = r (1 + r)^n / ((1 + r)^n - 1) over the period n (1/n at a zero rate). An
average annual cost entered directly replaces the computation.

Costs, like outputs, are measured above No Action, so No Action sits at the origin.

Tests: `annualize.test.ts` (including property tests of the closed forms against IWR Planning
Suite II's month-by-month and year-by-year sums), `utoy.test.ts`.

## 3. Rounding

Before any comparison, cost is rounded to 2 decimals (cents) and output to 3 decimals, half away
from zero, as IWR stores CURRENCY and DECIMAL values; values are then held as integers so every
comparison is exact. A project can keep full precision instead (the Utoy example does, to
reproduce its published numbers, which were computed at full precision in R).

## 4. Cost-effectiveness

A plan is **not cost-effective** when another plan produces the same output for strictly less
cost, or strictly more output for the same or less cost. Two plans with identical output and cost
are both cost-effective, as in IWR Planning Suite II.

Tests: `ceica_core.test.ts`, and `oracle.test.ts`: property tests against a reference written to
IWR Planning Suite II's rules, on tie-heavy random data (the reference is kept outside this
repository; the tests skip without it).

## 5. Best buys

Best buys are the cost-effective plans on the lower boundary of the cost-output cloud, found by
walking from a base point to ever-flatter... more precisely, to the next plan with the lowest
incremental cost per unit of added output:

* The base is No Action, unless some other plan produces No Action's output for less; then the
  base is (0, 0). No Action always reads as cost-effective and a best buy.
* From the current best buy, the next best buy is the plan with the lowest slope (added cost per
  added output) among plans with more output. Plans tied on that slope are all best buys (IWR's
  strict comparison taken in output order keeps collinear plans).
* A plan identical to a best buy is also a best buy; a plan identical to No Action is
  cost-effective but not a best buy.

Slopes are compared with exact integer cross products, never by division.

Tests: `ceica_core.test.ts` and `oracle.test.ts` (against the IWR reference), `utoy.test.ts`.

## 6. Increments

For consecutive best buys (starting from the origin), the increment is the added output, the
added cost, and the incremental cost per unit (added cost over added output; 0 when no output is
added). The average cost per unit of a plan is its cost over its output (0 at zero output), as
IWR Planning Suite II computes increments. The Utoy example's watershed increments are 1,477,
1,635, 2,531, 4,539, 4,929, 7,502 and 8,160 dollars per AAHU.

## 7. Watershed plans

**Formation.** Each site carries forward one alternative (its recommendation, the default) or,
in the several-per-site mode, any set of its alternatives. A watershed plan picks zero or one
carried alternative at each site. Plans are numbered in mixed radix with the first site most
significant; with one alternative per site this is the Utoy numbering
P = 1 + sum of bit x 2^(n - j).

**Rules** (IWR's relationships):

* *X not combinable with Y1, Y2, ...* rejects any plan that holds X and all of the Ys.
* *X depends on Y1, Y2, ...* requires all of the Ys whenever X is present. Several depends-on
  rules for X are alternatives: any one satisfied is enough.

A plan's output and cost are the sums of its sites' rounded values (IWR's watershed semantics).
Plans are enumerated in full up to 2,000,000, with a warning above IWR's 175,000. Beyond that,
only cost-effective plans are listed, found by merging site Pareto sets, which is exact because
effects add.

Tests: `plans.test.ts` (rules and the merge against brute force), `utoy.test.ts` (all 128
plans).

## 8. STAF: function scores to condition units

The Stream Tiered Assessment Framework scores 20 stream functions from 0 to 15. Each function
drives each of the three Clean Water Act outcomes (physical, chemical, biological) directly
(weight 1), indirectly (weight 0.1) or not at all (0). Two published mappings exist: A (STAF
documentation, EASI and DEEP) and B (the SFARI calculator); the project records which it uses.

For each outcome o, over the functions assessed at the site:

    sub-index_o = sum_f (score_f x w_fo) / sum_f (15 x w_fo)
    ECI = (sub-index_physical + sub-index_chemical + sub-index_biological) / 3

A function not assessed at a site drops out of both sums for every alternative and year (the
EASI and DEEP rule). A blank score for an assessed function leaves the ECI undefined and the site
incomplete. Condition bands: at most 0.39 Non-Functioning, at most 0.69 Functioning-at-Risk,
otherwise Functioning (on the ECI rounded to 2 decimals).

The output at a target year is **condition units**: the ECI times the quantity (stream length or
area). They are averaged and lifted like any other output.

**Lift by function and outcome.** For a fixed assessed set the ECI is linear in the scores,
ECI = sum_f sum_o c_fo x score_f with c_fo = w_fo / (3 x sum_f 15 w_fo). The lift therefore
splits exactly:

    lift = sum_f sum_o c_fo x A(q x (score_f - score_f of No Action))

where A is the time average. The function and outcome contributions shown in the app, the report
and the tables add up to the lift.

The ECI is not a certified or approved USACE planning model. STAF guidance treats it as a
supplement to habitat units from approved models.

Tests: `staf.test.ts` (the SFARI worked example: sub-indices 0.55, 0.70, 0.30 and ECI 0.52 under
mapping B; 0.58, 0.73, 0.30 and 0.54 under A; exact decomposition).

## 9. Decisions

The app suggests each site's largest best buy; the team confirms it or picks another alternative.
Decisions are stored by composition (which alternative at which site), never by plan number, and
each records a fingerprint of the results it was made on. When inputs change those results, the
decision reads "Needs review" until the team confirms it again (Keep recommendation for a site,
Keep this plan for the tentatively selected plan). Renaming a site or an alternative moves no
result, so a decision that was current stays current. The bundled examples record their
decisions the same way. The final array starts from the watershed best buys; the team may add
cost-effective plans and remove best buys (with a reason). Each step between final-array plans
records whether its added output is worth its added cost. The tentatively selected plan must be
in the final array. A report is Final only while every readiness item is checked (no input
problems, no suggestion left to confirm, nothing to review, a current tentatively selected
plan); otherwise it prints as a draft.

## 10. The Excel calculator

The calculator holds every input as an editable cell and every result as a formula: outputs and
their averages, IDC, OMRRR, annual costs, the site CE/ICA, the Sites recommendations, the
watershed plans (as live formulas up to 1,024 plans), the best buys, the final array and, for STAF
modules, the STAF roll-up. Beyond live formulas (more plans, several alternatives per site, or
rules), the plan sheet holds the app's values: every plan up to 10,000, otherwise the
cost-effective plans, with a note (the Report page's CSV lists every plan). It uses only
functions that exist in Excel 2016 and later. While CEICA was a Python app, its tests recalculated
the workbook in full (with the `formulas` package) and compared every result with the app; the
workbook the app writes now is that one, cell for cell. Cost-effectiveness and best buys use the
same integer-scaled comparisons as the engine. A hidden snapshot marks changed inputs, and the Read me sheet reports whether the
workbook still matches the export. Importing the workbook brings edited inputs and decisions back.

Tests: `files_workbooks.test.ts`, `imports.test.ts`.

## 11. Where results can differ from the Utoy R analysis, by design

* ecorest marks exact duplicate plans not cost-effective; IWR (and CEICA) keep both.
* Summing rounded site values moves a few watershed totals in the third decimal (plan P30 is
  90.822 against 90.821); every printed number in the report is unchanged.
* The published analysis passes Stream_Habitat to REFI's streambank input (index.Rmd lines 225 and
  233), where Streambank_Processes was meant. The example reproduces that.

## References

* IWR Planning Suite II (U.S. Army Corps of Engineers Institute for Water Resources): its CE/ICA,
  plan generation, relationship and annualizer modules, as they behave.
* McKay, S.K., and others. ecorest: an R package for ecosystem restoration decision support.
* McKay, Phillips, Abera and Menichino (2024). UtoyDecisions: CE/ICA for the Utoy Creek
  Section 206 study (https://github.com/USACE-WRISES/UtoyDecisions).
* Stream Tiered Assessment Framework (STAF) documentation and the SFARI, EASI and DEEP tools.
