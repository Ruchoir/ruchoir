"use client";

import { Icon, Tag } from "@/components/ds";
import { formatNumber } from "@/lib/i18n/format";
import { type TranslationKey, useTranslation } from "@/lib/i18n";
import { blockView, fallbackSentence, type PeopleLine, type PeopleView, type SeatsView, type Translate } from "./importPeople.ts";

/** A key chosen by the logic module (`importPeople.ts`); the tests name every one that exists. */
const dyn = (name: string) => name as unknown as TranslationKey;

/**
 * Who arrives with which role: the card of the plan and, once the run is over, of the done screen.
 *
 * It says what the archive says and nothing more: the administrators, the guests, the moderators,
 * the groups, the people already there whose role stays, and the custom roles that went to a fixed
 * one. For a licensed space that is filled, it also draws the seats, in red when they do not
 * suffice. Nobody becomes owner by import, and the first row says so.
 */
export function ImportPeopleBlock({
  people,
  source,
  sourceName,
  ownerName,
  pricingUrl,
}: {
  people: PeopleView | null;
  /** The archive's `source` (`slack`, `teams`, `mattermost`...), which picks the wording. */
  source: string;
  /** The product's name, for the sentences that name it. */
  sourceName: string;
  /** Who stays owner of a space the import creates; null when that is not known. */
  ownerName: string | null;
  pricingUrl?: string;
}) {
  const { t } = useTranslation();
  const view = blockView(people, source.toLowerCase(), ownerName);
  if (!view) return null;
  const tt: Translate = (name, vars) => t(dyn(name), vars);
  const pricing = pricingUrl ? (
    <a className="wc-imp-people__link" href={pricingUrl} target="_blank" rel="noreferrer">
      {t("roles.seePricing")}
      <Icon name="external-link" size={12} />
    </a>
  ) : null;
  return (
    <section className={`wc-imp-card wc-imp-people${view.over ? " wc-imp-people--over" : ""}`} aria-label={t("import.peopleTitle")}>
      <header className="wc-imp-people__head">
        <b>{t("import.peopleTitle")}</b>
        <span>{t("import.peopleSub")}</span>
      </header>
      {view.lines.map((line) => (
        <PeopleRow key={line.kind} line={line} sourceName={sourceName} tt={tt} pricing={view.pricing && line.kind === "fallbacks" ? pricing : null} />
      ))}
      {view.seats.map((seats) => (
        <SeatsRow key={seats.space} seats={seats} several={view.seats.length > 1} tt={tt} pricing={seats.tone === "over" ? pricing : null} />
      ))}
    </section>
  );
}

function PeopleRow({ line, sourceName, tt, pricing }: { line: PeopleLine; sourceName: string; tt: Translate; pricing: React.ReactNode }) {
  const { t } = useTranslation();
  const vars = { count: line.count, source: sourceName };
  return (
    <div className="wc-imp-people__row">
      <span className={`wc-imp-people__icon wc-imp-people__icon--${line.tone}`} aria-hidden>
        <Icon name={line.icon} size={14} />
      </span>
      <div className="wc-imp-people__body">
        <div className="wc-imp-people__title">{tt(line.titleKey, vars)}</div>
        <div className="wc-imp-people__text">
          {tt(line.bodyKey, vars)}
          {line.ownerKey ? <> {tt(line.ownerKey, { name: line.ownerName ?? "" })}</> : null}
        </div>
        {line.kind === "fallbacks" ? (
          <>
            <ul className="wc-imp-people__list">
              {line.fallbacks.map((f) => (
                <li key={`${f.space ?? ""}:${f.role}`}>{fallbackSentence(f, tt)}</li>
              ))}
            </ul>
            <div className="wc-imp-people__text">
              {t("import.peopleFallbacksPricing")} {pricing}
            </div>
          </>
        ) : null}
        {line.names.length > 0 ? (
          <div className="wc-imp-people__chips">
            {line.names.map((name) => (
              <Tag key={name} icon={line.kind === "groups" ? "users" : undefined}>
                {name}
              </Tag>
            ))}
            {line.more > 0 ? <Tag>{t("import.spacesMore", { count: line.more })}</Tag> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SeatsRow({ seats, several, tt, pricing }: { seats: SeatsView; several: boolean; tt: Translate; pricing: React.ReactNode }) {
  const { t } = useTranslation();
  const over = seats.tone === "over";
  const pct = (n: number) => `${Math.min(100, (n / Math.max(1, seats.total)) * 100)}%`;
  return (
    <div className={`wc-imp-seats${over ? " wc-imp-seats--over" : ""}`}>
      {over ? (
        <div className="wc-imp-seats__line">
          <Icon name="circle-alert" size={14} />
          <b>{tt("import.seatsOverTitle", { count: seats.added, left: formatNumber(seats.left) })}</b>
          <span>{tt("import.seatsOverTotal", { total: formatNumber(seats.total), used: formatNumber(seats.usedBefore) })}</span>
        </div>
      ) : (
        <div className="wc-imp-seats__line">
          <b>{tt("import.seatsUsed", { count: seats.usedAfter, total: formatNumber(seats.total) })}</b>
          <span>{tt("import.seatsFree", { count: seats.free })}</span>
        </div>
      )}
      {several ? <div className="wc-imp-seats__space">{seats.space}</div> : null}
      <div className="wc-imp-seats__bar" role="img" aria-label={tt("import.seatsUsed", { count: seats.usedAfter, total: formatNumber(seats.total) })}>
        <span className="wc-imp-seats__taken" style={{ width: pct(seats.usedBefore) }} />
        <span className="wc-imp-seats__added" style={{ width: pct(over ? seats.left : seats.added) }} />
      </div>
      <div className="wc-imp-seats__legend">
        <span className="wc-imp-seats__key wc-imp-seats__key--taken">{tt("import.seatsTaken", { count: seats.usedBefore })}</span>
        {over ? (
          <span className="wc-imp-seats__key wc-imp-seats__key--added">
            {tt("import.seatsOverLegend", {
              count: seats.left,
              incoming: seats.added,
              missing: tt("import.seatsMissingInline", { count: seats.missing }),
            })}
          </span>
        ) : (
          <>
            <span className="wc-imp-seats__key wc-imp-seats__key--added">{tt("import.seatsAdded", { count: seats.added })}</span>
            <span>{t("import.seatsGuestsFree")}</span>
          </>
        )}
      </div>
      {over ? (
        <p className="wc-imp-seats__text">
          {t("import.seatsOverText")} {pricing}
        </p>
      ) : null}
    </div>
  );
}
