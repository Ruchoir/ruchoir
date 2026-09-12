//! The three emails the server sends, in the six languages the product speaks.
//!
//! Kept in Rust rather than pulled from the web bundle's dictionaries: the API must be able to send
//! a password reset with no web build present, and these are three messages, not an interface. A
//! translation crate would add a dependency, a file format and a loader for less text than this
//! module holds.
//!
//! Which language a message goes out in:
//!
//! - **Verification and password reset** use the recipient's own language (`users.locale`), because
//!   the recipient is the only person who will read it. Unset means they have never chosen one, and
//!   French is what the product is written in.
//! - **An invitation** uses the language of whoever issued it. The recipient has no account yet, so
//!   nothing is known about them; the person inviting them has just typed their address and
//!   presumably shares a working language with them.

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

/// A ready-to-send message.
pub struct Email {
    pub subject: String,
    pub body: String,
}

/// Confirm a newly registered address.
pub fn verification(locale: Locale, link: &str, hours: i64) -> Email {
    match locale {
        Locale::Fr => Email {
            subject: "Confirmez votre adresse Ruchoir".to_owned(),
            body: format!(
                "Bienvenue sur Ruchoir.\n\nConfirmez votre adresse électronique en ouvrant ce lien :\n{link}\n\n\
                 Le lien expire dans {hours} heures. Si vous n'avez pas créé de compte, ignorez ce message."
            ),
        },
        Locale::En => Email {
            subject: "Confirm your Ruchoir email".to_owned(),
            body: format!(
                "Welcome to Ruchoir.\n\nConfirm your email address by opening this link:\n{link}\n\n\
                 The link expires in {hours} hours. If you did not create an account, ignore this message."
            ),
        },
        Locale::Es => Email {
            subject: "Confirma tu dirección de Ruchoir".to_owned(),
            body: format!(
                "Te damos la bienvenida a Ruchoir.\n\nConfirma tu correo electrónico abriendo este enlace:\n{link}\n\n\
                 El enlace caduca en {hours} horas. Si no has creado ninguna cuenta, ignora este mensaje."
            ),
        },
        Locale::De => Email {
            subject: "Bestätigen Sie Ihre Ruchoir-Adresse".to_owned(),
            body: format!(
                "Willkommen bei Ruchoir.\n\nBestätigen Sie Ihre E-Mail-Adresse über diesen Link:\n{link}\n\n\
                 Der Link läuft in {hours} Stunden ab. Falls Sie kein Konto erstellt haben, ignorieren Sie diese Nachricht."
            ),
        },
        Locale::It => Email {
            subject: "Conferma il tuo indirizzo Ruchoir".to_owned(),
            body: format!(
                "Benvenuto su Ruchoir.\n\nConferma il tuo indirizzo e-mail aprendo questo link:\n{link}\n\n\
                 Il link scade tra {hours} ore. Se non hai creato un account, ignora questo messaggio."
            ),
        },
        Locale::Pl => Email {
            subject: "Potwierdź swój adres w Ruchoirze".to_owned(),
            body: format!(
                "Witamy w Ruchoirze.\n\nPotwierdź swój adres e-mail, otwierając ten link:\n{link}\n\n\
                 Link wygasa za {hours} godz. Jeśli nie zakładałeś konta, zignoruj tę wiadomość."
            ),
        },
    }
}

/// Hand back an account whose password was forgotten.
pub fn password_reset(locale: Locale, link: &str, minutes: i64) -> Email {
    match locale {
        Locale::Fr => Email {
            subject: "Réinitialisez votre mot de passe Ruchoir".to_owned(),
            body: format!(
                "Une réinitialisation de mot de passe a été demandée pour votre compte Ruchoir.\n\n\
                 Choisissez un nouveau mot de passe ici :\n{link}\n\n\
                 Le lien expire dans {minutes} minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message."
            ),
        },
        Locale::En => Email {
            subject: "Reset your Ruchoir password".to_owned(),
            body: format!(
                "A password reset was requested for your Ruchoir account.\n\nSet a new password here:\n{link}\n\n\
                 The link expires in {minutes} minutes. If you did not request this, ignore this message."
            ),
        },
        Locale::Es => Email {
            subject: "Restablece tu contraseña de Ruchoir".to_owned(),
            body: format!(
                "Se ha solicitado restablecer la contraseña de tu cuenta de Ruchoir.\n\n\
                 Elige una nueva contraseña aquí:\n{link}\n\n\
                 El enlace caduca en {minutes} minutos. Si no has sido tú, ignora este mensaje."
            ),
        },
        Locale::De => Email {
            subject: "Setzen Sie Ihr Ruchoir-Passwort zurück".to_owned(),
            body: format!(
                "Für Ihr Ruchoir-Konto wurde eine Passwortzurücksetzung angefordert.\n\n\
                 Legen Sie hier ein neues Passwort fest:\n{link}\n\n\
                 Der Link läuft in {minutes} Minuten ab. Falls die Anfrage nicht von Ihnen stammt, ignorieren Sie diese Nachricht."
            ),
        },
        Locale::It => Email {
            subject: "Reimposta la tua password Ruchoir".to_owned(),
            body: format!(
                "È stata richiesta la reimpostazione della password per il tuo account Ruchoir.\n\n\
                 Scegli una nuova password qui:\n{link}\n\n\
                 Il link scade tra {minutes} minuti. Se non sei stato tu, ignora questo messaggio."
            ),
        },
        Locale::Pl => Email {
            subject: "Zresetuj hasło do Ruchoira".to_owned(),
            body: format!(
                "Zażądano zresetowania hasła do Twojego konta w Ruchoirze.\n\n\
                 Ustaw nowe hasło tutaj:\n{link}\n\n\
                 Link wygasa za {minutes} min. Jeśli to nie Ty, zignoruj tę wiadomość."
            ),
        },
    }
}

/// Invite someone into a space.
pub fn invitation(locale: Locale, space: &str, link: &str) -> Email {
    match locale {
        Locale::Fr => Email {
            subject: format!("Rejoignez {space} sur Ruchoir"),
            body: format!(
                "Vous avez été invité à rejoindre {space} sur Ruchoir.\n\nAcceptez l'invitation ici :\n{link}\n\n\
                 Si vous ne vous y attendiez pas, ignorez ce message."
            ),
        },
        Locale::En => Email {
            subject: format!("Join {space} on Ruchoir"),
            body: format!(
                "You have been invited to join {space} on Ruchoir.\n\nAccept the invitation here:\n{link}\n\n\
                 If you were not expecting this, ignore this message."
            ),
        },
        Locale::Es => Email {
            subject: format!("Únete a {space} en Ruchoir"),
            body: format!(
                "Te han invitado a unirte a {space} en Ruchoir.\n\nAcepta la invitación aquí:\n{link}\n\n\
                 Si no esperabas este mensaje, ignóralo."
            ),
        },
        Locale::De => Email {
            subject: format!("Treten Sie {space} auf Ruchoir bei"),
            body: format!(
                "Sie wurden eingeladen, {space} auf Ruchoir beizutreten.\n\nNehmen Sie die Einladung hier an:\n{link}\n\n\
                 Falls Sie damit nicht gerechnet haben, ignorieren Sie diese Nachricht."
            ),
        },
        Locale::It => Email {
            subject: format!("Unisciti a {space} su Ruchoir"),
            body: format!(
                "Hai ricevuto un invito a unirti a {space} su Ruchoir.\n\nAccetta l'invito qui:\n{link}\n\n\
                 Se non te lo aspettavi, ignora questo messaggio."
            ),
        },
        Locale::Pl => Email {
            subject: format!("Dołącz do {space} w Ruchoirze"),
            body: format!(
                "Otrzymałeś zaproszenie do dołączenia do {space} w Ruchoirze.\n\nPrzyjmij zaproszenie tutaj:\n{link}\n\n\
                 Jeśli się tego nie spodziewałeś, zignoruj tę wiadomość."
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn every_message_carries_its_link() {
        for locale in [
            Locale::Fr,
            Locale::En,
            Locale::Es,
            Locale::De,
            Locale::It,
            Locale::Pl,
        ] {
            assert!(verification(locale, "LINK", 24).body.contains("LINK"));
            assert!(password_reset(locale, "LINK", 30).body.contains("LINK"));
            let invite = invitation(locale, "SPACE", "LINK");
            assert!(invite.body.contains("LINK"));
            assert!(invite.subject.contains("SPACE"));
        }
    }
}
