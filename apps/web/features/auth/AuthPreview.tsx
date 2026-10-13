"use client";

import { Avatar, Icon } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";

/**
 * A drawn miniature of the app for the sign-in showcase: a channel list, two messages and an event
 * card. Made of markup rather than a screenshot so it follows the theme and the language, and never
 * shows an outdated interface. Purely decorative: hidden from assistive technology, no data.
 */
export function AuthPreview() {
  const { t } = useTranslation();
  const nameA = t("authPreview.nameA");
  const nameB = t("authPreview.nameB");
  return (
    <div className="wc-authpv" aria-hidden="true">
      <div className="wc-authpv__bar">
        <span className="wc-authpv__dot" />
        <span className="wc-authpv__dot" />
        <span className="wc-authpv__dot" />
      </div>
      <div className="wc-authpv__body">
        <div className="wc-authpv__nav">
          <span className="wc-authpv__chan wc-authpv__chan--on">
            <Icon name="hash" size={12} />
            {t("channel.fallbackName")}
          </span>
          <span className="wc-authpv__chan">
            <Icon name="hash" size={12} />
            {t("authPreview.channelProjects")}
          </span>
          <span className="wc-authpv__chan">
            <Icon name="hash" size={12} />
            {t("authPreview.channelNews")}
          </span>
        </div>
        <div className="wc-authpv__feed">
          <div className="wc-authpv__msg">
            <Avatar name={nameA} size={26} />
            <div>
              <div className="wc-authpv__author">{nameA}</div>
              <div className="wc-authpv__text">{t("authPreview.messageA")}</div>
            </div>
          </div>
          <div className="wc-authpv__msg">
            <Avatar name={nameB} size={26} />
            <div>
              <div className="wc-authpv__author">{nameB}</div>
              <div className="wc-authpv__text">{t("authPreview.messageB")}</div>
              <span className="wc-authpv__reaction">
                <Icon name="thumbs-up" size={11} />2
              </span>
            </div>
          </div>
          <div className="wc-authpv__event">
            <Icon name="calendar" size={14} />
            <div>
              <div className="wc-authpv__event-title">{t("authPreview.eventTitle")}</div>
              <div className="wc-authpv__event-when">{t("authPreview.eventWhen")}</div>
            </div>
          </div>
        </div>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/mascot-bee-alert.svg" alt="" className="wc-authpv__bee" />
    </div>
  );
}
