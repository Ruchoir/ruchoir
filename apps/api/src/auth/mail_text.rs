//! The three emails the server sends, in the six languages the product speaks, as a designed
//! HTML message with a plain-text alternative.
//!
//! Kept in Rust rather than pulled from the web bundle's dictionaries: the API must be able to send
//! a password reset with no web build present, and these are three messages, not an interface. A
//! translation crate would add a dependency, a file format and a loader for less text than this
//! module holds.
//!
//! Each message is written once, as content (a heading, a paragraph, a button, a note), and drawn
//! twice from it: as HTML in Ruchoir's colours, and as plain text for the clients that read that
//! instead. The two can therefore never say different things.
//!
//! Which language a message goes out in:
//!
//! - **Verification and password reset** use the language of the page that asked for them when
//!   there was one (the person reading the page is the person who will read the message), and the
//!   account's own language (`users.locale`) otherwise. Unset means French, the source language.
//! - **An invitation** uses the invited person's own language when they already have an account
//!   here, and the language of whoever issued it otherwise: nothing is known about a newcomer, and
//!   the person inviting them has just typed their address and presumably shares a working
//!   language with them.

use std::fmt;

/// A language the server can write in. Mirrors `apps/web/lib/i18n/config.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Locale {
    #[default]
    Fr,
    En,
    Es,
    De,
    It,
    Pl,
}

impl Locale {
    /// Parse a stored or submitted tag. Anything unknown falls back to the source language rather
    /// than failing: a message in French beats no message at all.
    pub fn parse(value: Option<&str>) -> Self {
        match value.unwrap_or("").split(['-', '_']).next().unwrap_or("") {
            "en" => Locale::En,
            "es" => Locale::Es,
            "de" => Locale::De,
            "it" => Locale::It,
            "pl" => Locale::Pl,
            _ => Locale::Fr,
        }
    }

    /// The tag as stored, so a round trip through the database is lossless.
    pub fn as_str(self) -> &'static str {
        match self {
            Locale::Fr => "fr",
            Locale::En => "en",
            Locale::Es => "es",
            Locale::De => "de",
            Locale::It => "it",
            Locale::Pl => "pl",
        }
    }
}

impl fmt::Display for Locale {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A ready-to-send message: its subject, and its body twice (plain text and HTML).
pub struct Email {
    pub subject: String,
    pub text: String,
    pub html: String,
}

/// The `Content-ID` the HTML refers to for the Ruchoir mark, which travels inside the message.
///
/// Embedded rather than fetched: most mail clients block remote images until the reader allows
/// them, and a logo shown as a broken frame is worse than no logo.
pub const LOGO_CID: &str = "ruchoir-mark";

/// The mark itself, 256 px, drawn at 36 so it stays sharp on a dense screen.
pub const LOGO_PNG: &[u8] = include_bytes!("../../assets/mail-mark.png");

/// What one message says, before it is drawn.
struct Content {
    subject: String,
    /// The line a mail client shows next to the subject in the inbox. Hidden in the message itself.
    preheader: String,
    heading: String,
    paragraph: String,
    button: String,
    link: String,
    /// Expiry and "not you?": small, under the button.
    note: String,
}

/// What every message says the same way, per language.
struct Common {
    tagline: &'static str,
    fallback: &'static str,
    sent_by: &'static str,
}

fn common(locale: Locale) -> Common {
    match locale {
        Locale::Fr => Common {
            tagline: "Une ruche pour tout votre travail.",
            fallback: "Le bouton ne fonctionne pas ? Copiez ce lien dans votre navigateur :",
            sent_by: "Envoyé par",
        },
        Locale::En => Common {
            tagline: "One hive for all your work.",
            fallback: "Button not working? Copy this link into your browser:",
            sent_by: "Sent by",
        },
        Locale::Es => Common {
            tagline: "Una colmena para todo tu trabajo.",
            fallback: "¿El botón no funciona? Copia este enlace en tu navegador:",
            sent_by: "Enviado por",
        },
        Locale::De => Common {
            tagline: "Ein Bienenstock für Ihre gesamte Arbeit.",
            fallback: "Der Button funktioniert nicht? Kopieren Sie diesen Link in Ihren Browser:",
            sent_by: "Gesendet von",
        },
        Locale::It => Common {
            tagline: "Un alveare per tutto il tuo lavoro.",
            fallback: "Il pulsante non funziona? Copia questo link nel tuo browser:",
            sent_by: "Inviato da",
        },
        Locale::Pl => Common {
            tagline: "Jeden ul dla całej Twojej pracy.",
            fallback: "Przycisk nie działa? Skopiuj ten link do przeglądarki:",
            sent_by: "Wysłano z",
        },
    }
}

/// Confirm a newly registered address.
pub fn verification(locale: Locale, link: &str, hours: i64, instance: &str) -> Email {
    let link = link.to_owned();
    let content = match locale {
        Locale::Fr => Content {
            subject: "Confirmez votre adresse Ruchoir".to_owned(),
            preheader: "Une dernière étape pour activer votre compte.".to_owned(),
            heading: "Confirmez votre adresse".to_owned(),
            paragraph: "Bienvenue sur Ruchoir. Il reste une étape : confirmer que cette adresse est bien la vôtre, pour activer votre compte.".to_owned(),
            button: "Confirmer mon adresse".to_owned(),
            link,
            note: format!("Ce lien expire dans {hours} heures. Si vous n'avez pas créé de compte Ruchoir, ignorez ce message : aucun compte ne sera activé."),
        },
        Locale::En => Content {
            subject: "Confirm your Ruchoir email".to_owned(),
            preheader: "One last step to activate your account.".to_owned(),
            heading: "Confirm your email address".to_owned(),
            paragraph: "Welcome to Ruchoir. One step left: confirm that this address is yours, to activate your account.".to_owned(),
            button: "Confirm my address".to_owned(),
            link,
            note: format!("This link expires in {hours} hours. If you did not create a Ruchoir account, ignore this message: no account will be activated."),
        },
        Locale::Es => Content {
            subject: "Confirma tu dirección de Ruchoir".to_owned(),
            preheader: "Un último paso para activar tu cuenta.".to_owned(),
            heading: "Confirma tu dirección".to_owned(),
            paragraph: "Te damos la bienvenida a Ruchoir. Queda un paso: confirmar que esta dirección es tuya para activar tu cuenta.".to_owned(),
            button: "Confirmar mi dirección".to_owned(),
            link,
            note: format!("Este enlace caduca en {hours} horas. Si no has creado ninguna cuenta de Ruchoir, ignora este mensaje: no se activará ninguna cuenta."),
        },
        Locale::De => Content {
            subject: "Bestätigen Sie Ihre Ruchoir-Adresse".to_owned(),
            preheader: "Ein letzter Schritt, um Ihr Konto zu aktivieren.".to_owned(),
            heading: "Bestätigen Sie Ihre Adresse".to_owned(),
            paragraph: "Willkommen bei Ruchoir. Nur noch ein Schritt: Bestätigen Sie, dass diese Adresse Ihnen gehört, um Ihr Konto zu aktivieren.".to_owned(),
            button: "Adresse bestätigen".to_owned(),
            link,
            note: format!("Dieser Link läuft in {hours} Stunden ab. Falls Sie kein Ruchoir-Konto erstellt haben, ignorieren Sie diese Nachricht: Es wird kein Konto aktiviert."),
        },
        Locale::It => Content {
            subject: "Conferma il tuo indirizzo Ruchoir".to_owned(),
            preheader: "Un ultimo passaggio per attivare il tuo account.".to_owned(),
            heading: "Conferma il tuo indirizzo".to_owned(),
            paragraph: "Benvenuto su Ruchoir. Manca un passaggio: conferma che questo indirizzo è tuo per attivare il tuo account.".to_owned(),
            button: "Conferma il mio indirizzo".to_owned(),
            link,
            note: format!("Questo link scade tra {hours} ore. Se non hai creato un account Ruchoir, ignora questo messaggio: nessun account verrà attivato."),
        },
        Locale::Pl => Content {
            subject: "Potwierdź swój adres w Ruchoirze".to_owned(),
            preheader: "Ostatni krok, aby aktywować konto.".to_owned(),
            heading: "Potwierdź swój adres".to_owned(),
            paragraph: "Witamy w Ruchoirze. Został jeden krok: potwierdź, że ten adres należy do Ciebie, aby aktywować konto.".to_owned(),
            button: "Potwierdź adres".to_owned(),
            link,
            note: format!("Link wygasa za {hours} godz. Jeśli nie zakładałeś konta w Ruchoirze, zignoruj tę wiadomość: żadne konto nie zostanie aktywowane."),
        },
    };
    render(locale, &content, instance)
}

/// Hand back an account whose password was forgotten.
pub fn password_reset(locale: Locale, link: &str, minutes: i64, instance: &str) -> Email {
    let link = link.to_owned();
    let content = match locale {
        Locale::Fr => Content {
            subject: "Réinitialisez votre mot de passe Ruchoir".to_owned(),
            preheader: "Choisissez un nouveau mot de passe pour votre compte.".to_owned(),
            heading: "Réinitialisez votre mot de passe".to_owned(),
            paragraph: "Une réinitialisation du mot de passe a été demandée pour le compte Ruchoir associé à cette adresse.".to_owned(),
            button: "Choisir un nouveau mot de passe".to_owned(),
            link,
            note: format!("Ce lien expire dans {minutes} minutes et ne sert qu'une fois. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé."),
        },
        Locale::En => Content {
            subject: "Reset your Ruchoir password".to_owned(),
            preheader: "Choose a new password for your account.".to_owned(),
            heading: "Reset your password".to_owned(),
            paragraph: "A password reset was requested for the Ruchoir account linked to this address.".to_owned(),
            button: "Choose a new password".to_owned(),
            link,
            note: format!("This link expires in {minutes} minutes and works once. If you did not request this, ignore this message: your password stays as it is."),
        },
        Locale::Es => Content {
            subject: "Restablece tu contraseña de Ruchoir".to_owned(),
            preheader: "Elige una nueva contraseña para tu cuenta.".to_owned(),
            heading: "Restablece tu contraseña".to_owned(),
            paragraph: "Se ha solicitado restablecer la contraseña de la cuenta de Ruchoir asociada a esta dirección.".to_owned(),
            button: "Elegir una nueva contraseña".to_owned(),
            link,
            note: format!("Este enlace caduca en {minutes} minutos y solo sirve una vez. Si no has sido tú, ignora este mensaje: tu contraseña no cambia."),
        },
        Locale::De => Content {
            subject: "Setzen Sie Ihr Ruchoir-Passwort zurück".to_owned(),
            preheader: "Legen Sie ein neues Passwort für Ihr Konto fest.".to_owned(),
            heading: "Passwort zurücksetzen".to_owned(),
            paragraph: "Für das Ruchoir-Konto mit dieser Adresse wurde das Zurücksetzen des Passworts angefordert.".to_owned(),
            button: "Neues Passwort festlegen".to_owned(),
            link,
            note: format!("Dieser Link läuft in {minutes} Minuten ab und funktioniert nur einmal. Falls die Anfrage nicht von Ihnen stammt, ignorieren Sie diese Nachricht: Ihr Passwort bleibt unverändert."),
        },
        Locale::It => Content {
            subject: "Reimposta la tua password Ruchoir".to_owned(),
            preheader: "Scegli una nuova password per il tuo account.".to_owned(),
            heading: "Reimposta la tua password".to_owned(),
            paragraph: "È stata richiesta la reimpostazione della password per l'account Ruchoir associato a questo indirizzo.".to_owned(),
            button: "Scegli una nuova password".to_owned(),
            link,
            note: format!("Questo link scade tra {minutes} minuti e funziona una sola volta. Se non sei stato tu, ignora questo messaggio: la tua password resta invariata."),
        },
        Locale::Pl => Content {
            subject: "Zresetuj hasło do Ruchoira".to_owned(),
            preheader: "Ustaw nowe hasło do swojego konta.".to_owned(),
            heading: "Zresetuj hasło".to_owned(),
            paragraph: "Zażądano zresetowania hasła do konta w Ruchoirze powiązanego z tym adresem.".to_owned(),
            button: "Ustaw nowe hasło".to_owned(),
            link,
            note: format!("Link wygasa za {minutes} min i działa tylko raz. Jeśli to nie Ty, zignoruj tę wiadomość: Twoje hasło pozostanie bez zmian."),
        },
    };
    render(locale, &content, instance)
}

/// Invite someone into a space. `inviter` is the display name of whoever issued it, when known.
pub fn invitation(
    locale: Locale,
    space: &str,
    inviter: Option<&str>,
    link: &str,
    instance: &str,
) -> Email {
    let link = link.to_owned();
    let content = match locale {
        Locale::Fr => Content {
            subject: format!("Rejoignez {space} sur Ruchoir"),
            preheader: format!("Une invitation vous attend dans l'espace {space}."),
            heading: format!("Rejoignez {space}"),
            paragraph: match inviter {
                Some(who) => format!("{who} vous invite à rejoindre l'espace {space} sur Ruchoir : les conversations, les fils de discussion et les fichiers de l'équipe, au même endroit."),
                None => format!("On vous invite à rejoindre l'espace {space} sur Ruchoir : les conversations, les fils de discussion et les fichiers de l'équipe, au même endroit."),
            },
            button: "Accepter l'invitation".to_owned(),
            link,
            note: "Si vous ne vous attendiez pas à cette invitation, ignorez ce message.".to_owned(),
        },
        Locale::En => Content {
            subject: format!("Join {space} on Ruchoir"),
            preheader: format!("An invitation is waiting for you in {space}."),
            heading: format!("Join {space}"),
            paragraph: match inviter {
                Some(who) => format!("{who} invited you to join the {space} space on Ruchoir: the team's conversations, threads and files, in one place."),
                None => format!("You have been invited to join the {space} space on Ruchoir: the team's conversations, threads and files, in one place."),
            },
            button: "Accept the invitation".to_owned(),
            link,
            note: "If you were not expecting this invitation, ignore this message.".to_owned(),
        },
        Locale::Es => Content {
            subject: format!("Únete a {space} en Ruchoir"),
            preheader: format!("Te espera una invitación en {space}."),
            heading: format!("Únete a {space}"),
            paragraph: match inviter {
                Some(who) => format!("{who} te invita a unirte al espacio {space} en Ruchoir: las conversaciones, los hilos y los archivos del equipo, en un solo lugar."),
                None => format!("Te han invitado a unirte al espacio {space} en Ruchoir: las conversaciones, los hilos y los archivos del equipo, en un solo lugar."),
            },
            button: "Aceptar la invitación".to_owned(),
            link,
            note: "Si no esperabas esta invitación, ignora este mensaje.".to_owned(),
        },
        Locale::De => Content {
            subject: format!("Treten Sie {space} auf Ruchoir bei"),
            preheader: format!("In {space} wartet eine Einladung auf Sie."),
            heading: format!("Treten Sie {space} bei"),
            paragraph: match inviter {
                Some(who) => format!("{who} lädt Sie in den Bereich {space} auf Ruchoir ein: Unterhaltungen, Threads und Dateien des Teams an einem Ort."),
                None => format!("Sie wurden in den Bereich {space} auf Ruchoir eingeladen: Unterhaltungen, Threads und Dateien des Teams an einem Ort."),
            },
            button: "Einladung annehmen".to_owned(),
            link,
            note: "Falls Sie diese Einladung nicht erwartet haben, ignorieren Sie diese Nachricht.".to_owned(),
        },
        Locale::It => Content {
            subject: format!("Unisciti a {space} su Ruchoir"),
            preheader: format!("Ti aspetta un invito in {space}."),
            heading: format!("Unisciti a {space}"),
            paragraph: match inviter {
                Some(who) => format!("{who} ti invita a unirti allo spazio {space} su Ruchoir: le conversazioni, le discussioni e i file del team, in un unico posto."),
                None => format!("Sei stato invitato a unirti allo spazio {space} su Ruchoir: le conversazioni, le discussioni e i file del team, in un unico posto."),
            },
            button: "Accetta l'invito".to_owned(),
            link,
            note: "Se non ti aspettavi questo invito, ignora questo messaggio.".to_owned(),
        },
        Locale::Pl => Content {
            subject: format!("Dołącz do {space} w Ruchoirze"),
            preheader: format!("Czeka na Ciebie zaproszenie do {space}."),
            heading: format!("Dołącz do {space}"),
            paragraph: match inviter {
                Some(who) => format!("{who} zaprasza Cię do przestrzeni {space} w Ruchoirze: rozmowy, wątki i pliki zespołu w jednym miejscu."),
                None => format!("Otrzymujesz zaproszenie do przestrzeni {space} w Ruchoirze: rozmowy, wątki i pliki zespołu w jednym miejscu."),
            },
            button: "Przyjmij zaproszenie".to_owned(),
            link,
            note: "Jeśli nie spodziewałeś się tego zaproszenia, zignoruj tę wiadomość.".to_owned(),
        },
    };
    render(locale, &content, instance)
}

/// Escape text for HTML: names and topics are somebody's text, never markup.
fn esc(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

// Ruchoir's light palette, from `apps/web/app/tokens.css`. Mail clients read no custom properties,
// so the values are written out.
const CREAM: &str = "#f7f3ed";
const CARD: &str = "#ffffff";
const BORDER: &str = "#e8ded2";
const INK: &str = "#171716";
const BODY: &str = "#4b4945";
const MUTED: &str = "#807a74";
const TERRACOTTA: &str = "#c65d45";
const FONT: &str = "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/// Draw a message twice, as HTML and as plain text, from the same content.
fn render(locale: Locale, content: &Content, instance: &str) -> Email {
    let common = common(locale);
    let text = format!(
        "{heading}\n\n{paragraph}\n\n{button} :\n{link}\n\n{note}\n\n-- \nRuchoir. {tagline}\n{sent_by} {instance}",
        heading = content.heading,
        paragraph = content.paragraph,
        button = content.button,
        link = content.link,
        note = content.note,
        tagline = common.tagline,
        sent_by = common.sent_by,
    );
    // The colon before a link is French typography; elsewhere it sits against the word.
    let text = if locale == Locale::Fr {
        text
    } else {
        text.replace(
            &format!("{} :\n", content.button),
            &format!("{}:\n", content.button),
        )
    };

    let lang = locale.as_str();
    let link = esc(&content.link);
    let html = format!(
        r#"<!DOCTYPE html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>{subject}</title>
<style>
@media (max-width: 480px) {{
  .rc-outer {{ padding: 24px 12px !important; }}
  .rc-card {{ padding: 28px 22px 24px 22px !important; }}
  .rc-title {{ font-size: 20px !important; }}
  .rc-button a {{ display: block !important; text-align: center !important; }}
}}
</style>
</head>
<body style="margin:0;padding:0;background:{CREAM};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">{preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{CREAM};">
<tr><td align="center" class="rc-outer" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td style="padding:0 4px 24px 4px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;"><img src="cid:{LOGO_CID}" width="36" height="36" alt="" style="display:block;border:0;"></td>
<td style="vertical-align:middle;padding-left:10px;font-family:{FONT};font-size:20px;font-weight:600;letter-spacing:-0.01em;color:{INK};">Ruchoir<span style="color:{TERRACOTTA};">.</span></td>
</tr></table>
</td></tr>
<tr><td class="rc-card" style="background:{CARD};border:1px solid {BORDER};border-top:4px solid {TERRACOTTA};border-radius:12px;padding:36px 36px 32px 36px;">
<h1 class="rc-title" style="margin:0 0 14px 0;font-family:{FONT};font-size:22px;line-height:1.3;font-weight:600;letter-spacing:-0.01em;color:{INK};">{heading}</h1>
<p style="margin:0 0 28px 0;font-family:{FONT};font-size:15px;line-height:1.6;color:{BODY};">{paragraph}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="rc-button-table"><tr>
<td align="center" bgcolor="{TERRACOTTA}" class="rc-button" style="border-radius:8px;">
<a href="{link}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:{FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">{button}</a>
</td></tr></table>
<p style="margin:28px 0 6px 0;font-family:{FONT};font-size:13px;line-height:1.5;color:{MUTED};">{fallback}</p>
<p style="margin:0 0 24px 0;font-family:{FONT};font-size:13px;line-height:1.5;word-break:break-all;"><a href="{link}" target="_blank" style="color:{TERRACOTTA};text-decoration:underline;">{link}</a></p>
<p style="margin:0;padding-top:20px;border-top:1px solid {BORDER};font-family:{FONT};font-size:13px;line-height:1.55;color:{MUTED};">{note}</p>
</td></tr>
<tr><td align="center" style="padding:24px 16px 0 16px;font-family:{FONT};font-size:12px;line-height:1.6;color:{MUTED};">
<span style="color:{INK};font-weight:600;">Ruchoir.</span> {tagline}<br>
{sent_by} {instance}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
"#,
        subject = esc(&content.subject),
        preheader = esc(&content.preheader),
        heading = esc(&content.heading),
        paragraph = esc(&content.paragraph),
        button = esc(&content.button),
        fallback = esc(common.fallback),
        note = esc(&content.note),
        tagline = esc(common.tagline),
        sent_by = esc(common.sent_by),
        instance = esc(instance),
    );

    Email {
        subject: content.subject.clone(),
        text,
        html,
    }
}

/// Send every message in every language to `to`, with sample content (`mail-preview`).
pub async fn send_previews(config: &crate::config::Config, to: &str) -> Result<(), String> {
    let mailer = super::mailer::Mailer::from_config(config)?;
    if !mailer.can_send() {
        return Err(
            "no SMTP relay configured: set RUCHOIR_SMTP_HOST (a mail catcher in development)"
                .to_owned(),
        );
    }
    let instance = mailer.instance_name();
    let base = mailer.base_url.trim_end_matches('/').to_owned();
    let all = [
        Locale::Fr,
        Locale::En,
        Locale::Es,
        Locale::De,
        Locale::It,
        Locale::Pl,
    ];
    let mut sent = 0;
    for locale in all {
        for email in [
            verification(
                locale,
                &format!("{base}/verify-email?token=preview"),
                24,
                &instance,
            ),
            password_reset(
                locale,
                &format!("{base}/reset-password?token=preview"),
                60,
                &instance,
            ),
            invitation(
                locale,
                "Atelier",
                Some("Camille Roussel"),
                &format!("{base}/invite?token=preview"),
                &instance,
            ),
        ] {
            mailer.send(to, &email).await?;
            sent += 1;
        }
    }
    println!("{sent} messages sent to {to}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Locale; 6] = [
        Locale::Fr,
        Locale::En,
        Locale::Es,
        Locale::De,
        Locale::It,
        Locale::Pl,
    ];

    #[test]
    fn parses_a_tag_with_a_region() {
        assert_eq!(Locale::parse(Some("de-AT")), Locale::De);
        assert_eq!(Locale::parse(Some("pl_PL")), Locale::Pl);
    }

    #[test]
    fn falls_back_to_the_source_language() {
        assert_eq!(Locale::parse(None), Locale::Fr);
        assert_eq!(Locale::parse(Some("")), Locale::Fr);
        assert_eq!(Locale::parse(Some("ja")), Locale::Fr);
    }

    #[test]
    fn every_message_carries_its_link_in_both_bodies() {
        for locale in ALL {
            for email in [
                verification(locale, "https://x.test/v?token=LINK", 24, "x.test"),
                password_reset(locale, "https://x.test/r?token=LINK", 30, "x.test"),
                invitation(
                    locale,
                    "SPACE",
                    Some("Camille"),
                    "https://x.test/i?token=LINK",
                    "x.test",
                ),
            ] {
                assert!(email.text.contains("token=LINK"), "{locale}");
                assert!(email.html.contains("token=LINK"), "{locale}");
                assert!(email.html.contains(&format!("cid:{LOGO_CID}")), "{locale}");
                assert!(email
                    .html
                    .contains(&format!("lang=\"{}\"", locale.as_str())));
            }
            let invite = invitation(locale, "SPACE", Some("Camille"), "L", "x.test");
            assert!(invite.subject.contains("SPACE"));
            assert!(invite.text.contains("Camille"));
        }
    }

    #[test]
    fn what_people_typed_is_never_markup() {
        let email = invitation(
            Locale::En,
            "<script>alert(1)</script>",
            Some("Eve & \"Co\""),
            "https://x.test/i?a=1&b=2",
            "x.test",
        );
        assert!(!email.html.contains("<script>"));
        assert!(email.html.contains("&lt;script&gt;"));
        assert!(email.html.contains("Eve &amp; &quot;Co&quot;"));
        assert!(email.html.contains("a=1&amp;b=2"));
    }
}
