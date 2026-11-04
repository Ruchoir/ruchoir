//! The emails the server sends, in the six languages the product speaks, as a designed HTML message
//! with a plain-text alternative, plus the few words a push notification needs.
//!
//! Kept in Rust rather than pulled from the web bundle's dictionaries: the API must be able to send
//! a password reset with no web build present, and these are four messages, not an interface. A
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
//! - **The unread digest** (and a push notification's text) use the account's own language: nobody
//!   asked for them from a page, they are addressed to the account.

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
    /// An iCalendar object to attach (an invitation, its change or its cancellation), with its
    /// `METHOD`: mail clients offer to add it to the reader's calendar.
    pub calendar: Option<CalendarPart>,
}

/// An `.ics` attachment.
#[derive(Debug, Clone)]
pub struct CalendarPart {
    /// `REQUEST` or `CANCEL`.
    pub method: &'static str,
    pub body: String,
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
    /// A list drawn between the paragraph and the button. Empty for every message but the digest.
    items: Vec<DigestItem>,
}

/// One line of the unread digest: what happened, and the first words of the message.
#[derive(Debug, Clone)]
pub struct DigestItem {
    /// "Camille vous a mentionné · #général".
    pub headline: String,
    /// A one-line excerpt of the message. May be empty (an attachment alone).
    pub excerpt: String,
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
pub fn verification(locale: Locale, link: &str, code: &str, hours: i64, instance: &str) -> Email {
    let link = link.to_owned();
    let content = match locale {
        Locale::Fr => Content {
            subject: "Confirmez votre adresse Ruchoir".to_owned(),
            preheader: "Une dernière étape pour activer votre compte.".to_owned(),
            heading: "Confirmez votre adresse".to_owned(),
            paragraph: "Bienvenue sur Ruchoir. Il reste une étape : confirmer que cette adresse est bien la vôtre, pour activer votre compte.".to_owned(),
            button: "Confirmer mon adresse".to_owned(),
            link,
            note: format!("Ce lien et ce code expirent dans {hours} heures. Si vous n'avez pas créé de compte Ruchoir, ignorez ce message : aucun compte ne sera activé."),
            items: Vec::new(),
        },
        Locale::En => Content {
            subject: "Confirm your Ruchoir email".to_owned(),
            preheader: "One last step to activate your account.".to_owned(),
            heading: "Confirm your email address".to_owned(),
            paragraph: "Welcome to Ruchoir. One step left: confirm that this address is yours, to activate your account.".to_owned(),
            button: "Confirm my address".to_owned(),
            link,
            note: format!("This link and this code expire in {hours} hours. If you did not create a Ruchoir account, ignore this message: no account will be activated."),
            items: Vec::new(),
        },
        Locale::Es => Content {
            subject: "Confirma tu dirección de Ruchoir".to_owned(),
            preheader: "Un último paso para activar tu cuenta.".to_owned(),
            heading: "Confirma tu dirección".to_owned(),
            paragraph: "Te damos la bienvenida a Ruchoir. Queda un paso: confirmar que esta dirección es tuya para activar tu cuenta.".to_owned(),
            button: "Confirmar mi dirección".to_owned(),
            link,
            note: format!("Este enlace y este código caducan en {hours} horas. Si no has creado ninguna cuenta de Ruchoir, ignora este mensaje: no se activará ninguna cuenta."),
            items: Vec::new(),
        },
        Locale::De => Content {
            subject: "Bestätigen Sie Ihre Ruchoir-Adresse".to_owned(),
            preheader: "Ein letzter Schritt, um Ihr Konto zu aktivieren.".to_owned(),
            heading: "Bestätigen Sie Ihre Adresse".to_owned(),
            paragraph: "Willkommen bei Ruchoir. Nur noch ein Schritt: Bestätigen Sie, dass diese Adresse Ihnen gehört, um Ihr Konto zu aktivieren.".to_owned(),
            button: "Adresse bestätigen".to_owned(),
            link,
            note: format!("Dieser Link und dieser Code laufen in {hours} Stunden ab. Falls Sie kein Ruchoir-Konto erstellt haben, ignorieren Sie diese Nachricht: Es wird kein Konto aktiviert."),
            items: Vec::new(),
        },
        Locale::It => Content {
            subject: "Conferma il tuo indirizzo Ruchoir".to_owned(),
            preheader: "Un ultimo passaggio per attivare il tuo account.".to_owned(),
            heading: "Conferma il tuo indirizzo".to_owned(),
            paragraph: "Benvenuto su Ruchoir. Manca un passaggio: conferma che questo indirizzo è tuo per attivare il tuo account.".to_owned(),
            button: "Conferma il mio indirizzo".to_owned(),
            link,
            note: format!("Questo link e questo codice scadono tra {hours} ore. Se non hai creato un account Ruchoir, ignora questo messaggio: nessun account verrà attivato."),
            items: Vec::new(),
        },
        Locale::Pl => Content {
            subject: "Potwierdź swój adres w Ruchoirze".to_owned(),
            preheader: "Ostatni krok, aby aktywować konto.".to_owned(),
            heading: "Potwierdź swój adres".to_owned(),
            paragraph: "Witamy w Ruchoirze. Został jeden krok: potwierdź, że ten adres należy do Ciebie, aby aktywować konto.".to_owned(),
            button: "Potwierdź adres".to_owned(),
            link,
            note: format!("Link i kod wygasają za {hours} godz. Jeśli nie zakładałeś konta w Ruchoirze, zignoruj tę wiadomość: żadne konto nie zostanie aktywowane."),
            items: Vec::new(),
        },
    };
    render_with_code(locale, &content, instance, Some(code))
}

/// The line that introduces the code under the verification link.
fn code_label(locale: Locale) -> &'static str {
    match locale {
        Locale::Fr => "Ou saisissez ce code dans Ruchoir :",
        Locale::En => "Or enter this code in Ruchoir:",
        Locale::Es => "O introduce este código en Ruchoir:",
        Locale::De => "Oder geben Sie diesen Code in Ruchoir ein:",
        Locale::It => "Oppure inserisci questo codice in Ruchoir:",
        Locale::Pl => "Albo wpisz ten kod w Ruchoirze:",
    }
}

/// A six-digit code as two groups of three, the way it is read and typed back.
fn grouped_code(code: &str) -> String {
    if code.len() == 6 && code.is_ascii() {
        format!("{} {}", &code[..3], &code[3..])
    } else {
        code.to_owned()
    }
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
            items: Vec::new(),
        },
        Locale::En => Content {
            subject: "Reset your Ruchoir password".to_owned(),
            preheader: "Choose a new password for your account.".to_owned(),
            heading: "Reset your password".to_owned(),
            paragraph: "A password reset was requested for the Ruchoir account linked to this address.".to_owned(),
            button: "Choose a new password".to_owned(),
            link,
            note: format!("This link expires in {minutes} minutes and works once. If you did not request this, ignore this message: your password stays as it is."),
            items: Vec::new(),
        },
        Locale::Es => Content {
            subject: "Restablece tu contraseña de Ruchoir".to_owned(),
            preheader: "Elige una nueva contraseña para tu cuenta.".to_owned(),
            heading: "Restablece tu contraseña".to_owned(),
            paragraph: "Se ha solicitado restablecer la contraseña de la cuenta de Ruchoir asociada a esta dirección.".to_owned(),
            button: "Elegir una nueva contraseña".to_owned(),
            link,
            note: format!("Este enlace caduca en {minutes} minutos y solo sirve una vez. Si no has sido tú, ignora este mensaje: tu contraseña no cambia."),
            items: Vec::new(),
        },
        Locale::De => Content {
            subject: "Setzen Sie Ihr Ruchoir-Passwort zurück".to_owned(),
            preheader: "Legen Sie ein neues Passwort für Ihr Konto fest.".to_owned(),
            heading: "Passwort zurücksetzen".to_owned(),
            paragraph: "Für das Ruchoir-Konto mit dieser Adresse wurde das Zurücksetzen des Passworts angefordert.".to_owned(),
            button: "Neues Passwort festlegen".to_owned(),
            link,
            note: format!("Dieser Link läuft in {minutes} Minuten ab und funktioniert nur einmal. Falls die Anfrage nicht von Ihnen stammt, ignorieren Sie diese Nachricht: Ihr Passwort bleibt unverändert."),
            items: Vec::new(),
        },
        Locale::It => Content {
            subject: "Reimposta la tua password Ruchoir".to_owned(),
            preheader: "Scegli una nuova password per il tuo account.".to_owned(),
            heading: "Reimposta la tua password".to_owned(),
            paragraph: "È stata richiesta la reimpostazione della password per l'account Ruchoir associato a questo indirizzo.".to_owned(),
            button: "Scegli una nuova password".to_owned(),
            link,
            note: format!("Questo link scade tra {minutes} minuti e funziona una sola volta. Se non sei stato tu, ignora questo messaggio: la tua password resta invariata."),
            items: Vec::new(),
        },
        Locale::Pl => Content {
            subject: "Zresetuj hasło do Ruchoira".to_owned(),
            preheader: "Ustaw nowe hasło do swojego konta.".to_owned(),
            heading: "Zresetuj hasło".to_owned(),
            paragraph: "Zażądano zresetowania hasła do konta w Ruchoirze powiązanego z tym adresem.".to_owned(),
            button: "Ustaw nowe hasło".to_owned(),
            link,
            note: format!("Link wygasa za {minutes} min i działa tylko raz. Jeśli to nie Ty, zignoruj tę wiadomość: Twoje hasło pozostanie bez zmian."),
            items: Vec::new(),
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
            items: Vec::new(),
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
            items: Vec::new(),
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
            items: Vec::new(),
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
            items: Vec::new(),
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
            items: Vec::new(),
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
            items: Vec::new(),
        },
    };
    render(locale, &content, instance)
}

/// What happened, as a short verb phrase after the actor's name, per notification kind. The same
/// words as the web inbox (`notif.mentioned`, `notif.broadcast`, ...), so a push, an email and the
/// app describe one event the same way.
pub fn notification_verb(locale: Locale, kind: &str) -> &'static str {
    match (locale, kind) {
        (Locale::Fr, "mention") => "vous a mentionné",
        (Locale::Fr, "broadcast") => "a mentionné tout le canal",
        (Locale::Fr, "reply") => "a répondu dans un fil",
        (Locale::Fr, "reaction") => "a réagi à votre message",
        (Locale::Fr, "edited") => "a modifié un message",
        (Locale::Fr, "message") => "a écrit",
        (Locale::Fr, _) => "vous a envoyé un message",
        (Locale::En, "mention") => "mentioned you",
        (Locale::En, "broadcast") => "mentioned the whole channel",
        (Locale::En, "reply") => "replied in a thread",
        (Locale::En, "reaction") => "reacted to your message",
        (Locale::En, "edited") => "edited a message",
        (Locale::En, "message") => "wrote",
        (Locale::En, _) => "sent you a message",
        (Locale::Es, "mention") => "te ha mencionado",
        (Locale::Es, "broadcast") => "ha mencionado a todo el canal",
        (Locale::Es, "reply") => "ha respondido en un hilo",
        (Locale::Es, "reaction") => "ha reaccionado a tu mensaje",
        (Locale::Es, "edited") => "ha editado un mensaje",
        (Locale::Es, "message") => "ha escrito",
        (Locale::Es, _) => "te ha enviado un mensaje",
        (Locale::De, "mention") => "hat Sie erwähnt",
        (Locale::De, "broadcast") => "hat den ganzen Kanal erwähnt",
        (Locale::De, "reply") => "hat in einem Thread geantwortet",
        (Locale::De, "reaction") => "hat auf Ihre Nachricht reagiert",
        (Locale::De, "edited") => "hat eine Nachricht bearbeitet",
        (Locale::De, "message") => "hat geschrieben",
        (Locale::De, _) => "hat Ihnen eine Nachricht geschickt",
        (Locale::It, "mention") => "ti ha menzionato",
        (Locale::It, "broadcast") => "ha menzionato tutto il canale",
        (Locale::It, "reply") => "ha risposto in una discussione",
        (Locale::It, "reaction") => "ha reagito al tuo messaggio",
        (Locale::It, "edited") => "ha modificato un messaggio",
        (Locale::It, "message") => "ha scritto",
        (Locale::It, _) => "ti ha inviato un messaggio",
        (Locale::Pl, "mention") => "wspomniał o Tobie",
        (Locale::Pl, "broadcast") => "wspomniał o całym kanale",
        (Locale::Pl, "reply") => "odpowiedział w wątku",
        (Locale::Pl, "reaction") => "zareagował na Twoją wiadomość",
        (Locale::Pl, "edited") => "edytował wiadomość",
        (Locale::Pl, "message") => "napisał",
        (Locale::Pl, _) => "wysłał Ci wiadomość",
    }
}

/// The body of the test push sent from the preferences.
pub fn push_test_body(locale: Locale) -> &'static str {
    match locale {
        Locale::Fr => "Les notifications arrivent bien sur cet appareil, même Ruchoir fermé.",
        Locale::En => "Notifications reach this device, even with Ruchoir closed.",
        Locale::Es => "Las notificaciones llegan a este dispositivo, incluso con Ruchoir cerrado.",
        Locale::De => {
            "Benachrichtigungen erreichen dieses Gerät, auch wenn Ruchoir geschlossen ist."
        }
        Locale::It => "Le notifiche arrivano su questo dispositivo, anche con Ruchoir chiuso.",
        Locale::Pl => "Powiadomienia docierają na to urządzenie, nawet gdy Ruchoir jest zamknięty.",
    }
}

/// Who did something when their account is gone: the notification outlives its actor.
pub fn someone(locale: Locale) -> &'static str {
    match locale {
        Locale::Fr => "Quelqu'un",
        Locale::En => "Someone",
        Locale::Es => "Alguien",
        Locale::De => "Jemand",
        Locale::It => "Qualcuno",
        Locale::Pl => "Ktoś",
    }
}

/// The unread digest: what is still waiting for someone who has not had Ruchoir open.
///
/// `items` is what the message lists (the caller caps it) and `total` how many are unread in all, so
/// a long backlog is summarised rather than pasted in full.
pub fn unread_digest(
    locale: Locale,
    items: Vec<DigestItem>,
    total: usize,
    link: &str,
    instance: &str,
) -> Email {
    let link = link.to_owned();
    let more = total.saturating_sub(items.len());
    let preheader = items
        .first()
        .map(|item| item.headline.clone())
        .unwrap_or_default();
    let mut content = match locale {
        Locale::Fr => Content {
            subject: if total == 1 {
                "Une notification non lue sur Ruchoir".to_owned()
            } else {
                format!("{total} notifications non lues sur Ruchoir")
            },
            preheader,
            heading: "Pendant votre absence".to_owned(),
            paragraph: "Voici ce qui vous attend sur Ruchoir et que vous n'avez pas encore lu.".to_owned(),
            button: "Ouvrir Ruchoir".to_owned(),
            link,
            note: "Vous recevez cet e-mail parce que ces notifications sont restées non lues alors que Ruchoir n'était ouvert nulle part. Pour ne plus en recevoir, désactivez « Rattrapage par e-mail » dans Préférences > Notifications.".to_owned(),
            items,
        },
        Locale::En => Content {
            subject: if total == 1 {
                "One unread notification on Ruchoir".to_owned()
            } else {
                format!("{total} unread notifications on Ruchoir")
            },
            preheader,
            heading: "While you were away".to_owned(),
            paragraph: "Here is what is waiting for you on Ruchoir and that you have not read yet.".to_owned(),
            button: "Open Ruchoir".to_owned(),
            link,
            note: "You are receiving this email because these notifications stayed unread while Ruchoir was not open anywhere. To stop them, turn off \u{201c}Email catch-up\u{201d} in Preferences > Notifications.".to_owned(),
            items,
        },
        Locale::Es => Content {
            subject: if total == 1 {
                "Una notificación sin leer en Ruchoir".to_owned()
            } else {
                format!("{total} notificaciones sin leer en Ruchoir")
            },
            preheader,
            heading: "Mientras no estabas".to_owned(),
            paragraph: "Esto es lo que te espera en Ruchoir y que aún no has leído.".to_owned(),
            button: "Abrir Ruchoir".to_owned(),
            link,
            note: "Recibes este correo porque estas notificaciones quedaron sin leer mientras Ruchoir no estaba abierto en ningún sitio. Para dejar de recibirlos, desactiva «Resumen por correo» en Preferencias > Notificaciones.".to_owned(),
            items,
        },
        Locale::De => Content {
            subject: if total == 1 {
                "Eine ungelesene Benachrichtigung in Ruchoir".to_owned()
            } else {
                format!("{total} ungelesene Benachrichtigungen in Ruchoir")
            },
            preheader,
            heading: "Während Sie weg waren".to_owned(),
            paragraph: "Das wartet in Ruchoir auf Sie und ist noch ungelesen.".to_owned(),
            button: "Ruchoir öffnen".to_owned(),
            link,
            note: "Sie erhalten diese E-Mail, weil diese Benachrichtigungen ungelesen geblieben sind, während Ruchoir nirgends geöffnet war. Um keine mehr zu erhalten, deaktivieren Sie \u{201e}E-Mail-Zusammenfassung\u{201c} unter Einstellungen > Benachrichtigungen.".to_owned(),
            items,
        },
        Locale::It => Content {
            subject: if total == 1 {
                "Una notifica non letta su Ruchoir".to_owned()
            } else {
                format!("{total} notifiche non lette su Ruchoir")
            },
            preheader,
            heading: "Mentre eri via".to_owned(),
            paragraph: "Ecco cosa ti aspetta su Ruchoir e non hai ancora letto.".to_owned(),
            button: "Apri Ruchoir".to_owned(),
            link,
            note: "Ricevi questa e-mail perché queste notifiche sono rimaste non lette mentre Ruchoir non era aperto da nessuna parte. Per non riceverne più, disattiva «Riepilogo via e-mail» in Preferenze > Notifiche.".to_owned(),
            items,
        },
        Locale::Pl => Content {
            subject: if total == 1 {
                "Jedno nieprzeczytane powiadomienie w Ruchoirze".to_owned()
            } else {
                format!("Nieprzeczytane powiadomienia w Ruchoirze: {total}")
            },
            preheader,
            heading: "Podczas Twojej nieobecności".to_owned(),
            paragraph: "Oto nieprzeczytane wiadomości, które czekają na Ciebie w Ruchoirze.".to_owned(),
            button: "Otwórz Ruchoir".to_owned(),
            link,
            note: "Otrzymujesz tę wiadomość, ponieważ te powiadomienia pozostały nieprzeczytane, gdy Ruchoir nie był nigdzie otwarty. Aby ich nie otrzymywać, wyłącz opcję „Podsumowanie e-mailem” w Preferencje > Powiadomienia.".to_owned(),
            items,
        },
    };
    if more > 0 {
        let tail = match locale {
            Locale::Fr => format!("Et {more} de plus."),
            Locale::En => format!("And {more} more."),
            Locale::Es => format!("Y {more} más."),
            Locale::De => format!("Und {more} weitere."),
            Locale::It => format!("E altre {more}."),
            Locale::Pl => format!("I jeszcze {more}."),
        };
        content.items.push(DigestItem {
            headline: tail,
            excerpt: String::new(),
        });
    }
    render(locale, &content, instance)
}

/// The words of a message written outside this module, for [`notice`]: by an edition built on
/// this crate (a licence about to expire), which has its own texts and no access to the layout.
#[derive(Debug, Clone, Copy)]
pub struct Notice<'a> {
    pub subject: &'a str,
    /// The line a mail client shows next to the subject in the inbox.
    pub preheader: &'a str,
    pub heading: &'a str,
    pub paragraph: &'a str,
    pub button: &'a str,
    pub link: &'a str,
    /// Small, under the button.
    pub note: &'a str,
}

/// Draw `notice` in Ruchoir's own layout, as HTML and plain text, escaped like every other message.
pub fn notice(locale: Locale, notice: &Notice<'_>, instance: &str) -> Email {
    render(
        locale,
        &Content {
            subject: notice.subject.to_owned(),
            preheader: notice.preheader.to_owned(),
            heading: notice.heading.to_owned(),
            paragraph: notice.paragraph.to_owned(),
            button: notice.button.to_owned(),
            link: notice.link.to_owned(),
            note: notice.note.to_owned(),
            items: Vec::new(),
        },
        instance,
    )
}

/// What a guest-expiry reminder says, for [`guest_expiry_reminder`].
#[derive(Debug, Clone, Copy)]
pub struct GuestExpiryWords<'a> {
    /// The reader's first name, for the greeting.
    pub reader: &'a str,
    pub guest: &'a str,
    /// The guest's profile title, when they have one.
    pub title: Option<&'a str>,
    pub space: &'a str,
    /// The end date as a reader writes it ("20 novembre 2026").
    pub ends: &'a str,
    /// Days left when it was written: `7` or `1`.
    pub days: i32,
    /// Where the button leads: the space's settings, Members, with the prolong dialog of this guest.
    pub link: &'a str,
}

/// The mail sent to the people who manage a guest, some days before the guest's access ends.
///
/// Neutral about the guest's gender in every language: "son accès", "cette personne", never an
/// "invité" or "invitée" agreeing with an assumption.
pub fn guest_expiry_reminder(
    locale: Locale,
    words: &GuestExpiryWords<'_>,
    instance: &str,
) -> Email {
    let (guest, space, ends, reader) = (words.guest, words.space, words.ends, words.reader);
    let many = words.days > 1;
    let days = words.days;
    let (subject, greeting, paragraph, until, after, button, note) = match locale {
        Locale::Fr => (
            if many {
                format!("L'accès de {guest} à {space} se termine dans {days} jours")
            } else {
                format!("L'accès de {guest} à {space} se termine demain")
            },
            format!("Bonjour {reader},"),
            format!(
                "L'accès de {guest} à l'espace {space} se termine le {ends}{}. Vous recevez ce message parce que vous gérez les invités de cet espace.",
                if many { format!(", dans {days} jours") } else { ", demain".to_owned() }
            ),
            "accès jusqu'au",
            format!("Si son travail avec vous continue, prolongez son accès. Sinon, vous n'avez rien à faire : le {ends}, cette personne n'aura plus accès à l'espace. Ses messages et ses fichiers resteront, et vous pourrez réactiver son accès pendant 90 jours."),
            "Prolonger son accès",
            "Vous recevrez un dernier rappel la veille. Pour ne plus recevoir ces messages, retirez-vous des personnes qui gèrent les invités.",
        ),
        Locale::En => (
            if many {
                format!("{guest}'s access to {space} ends in {days} days")
            } else {
                format!("{guest}'s access to {space} ends tomorrow")
            },
            format!("Hello {reader},"),
            format!(
                "{guest}'s access to the {space} space ends on {ends}{}. You receive this because you manage the guests of this space.",
                if many { format!(", in {days} days") } else { ", tomorrow".to_owned() }
            ),
            "access until",
            format!("If their work with you goes on, extend their access. Otherwise there is nothing to do: on {ends}, this person will no longer have access to the space. Their messages and files stay, and you can reactivate their access for 90 days."),
            "Extend their access",
            "A last reminder comes the day before. To stop receiving these messages, step down from managing guests.",
        ),
        Locale::Es => (
            if many {
                format!("El acceso de {guest} a {space} termina en {days} días")
            } else {
                format!("El acceso de {guest} a {space} termina mañana")
            },
            format!("Hola {reader},"),
            format!(
                "El acceso de {guest} al espacio {space} termina el {ends}{}. Recibes este mensaje porque gestionas a los invitados de este espacio.",
                if many { format!(", dentro de {days} días") } else { ", mañana".to_owned() }
            ),
            "acceso hasta el",
            format!("Si su trabajo contigo continúa, prolonga su acceso. Si no, no tienes nada que hacer: el {ends}, esta persona dejará de tener acceso al espacio. Sus mensajes y archivos se quedan y podrás reactivar su acceso durante 90 días."),
            "Prolongar su acceso",
            "Recibirás un último recordatorio la víspera. Para dejar de recibir estos mensajes, deja de gestionar a los invitados.",
        ),
        Locale::De => (
            if many {
                format!("Der Zugang von {guest} zu {space} endet in {days} Tagen")
            } else {
                format!("Der Zugang von {guest} zu {space} endet morgen")
            },
            format!("Guten Tag {reader},"),
            format!(
                "Der Zugang von {guest} zum Bereich {space} endet am {ends}{}. Sie erhalten diese Nachricht, weil Sie die Gäste dieses Bereichs verwalten.",
                if many { format!(", in {days} Tagen") } else { ", morgen".to_owned() }
            ),
            "Zugang bis",
            format!("Wenn die Zusammenarbeit weitergeht, verlängern Sie den Zugang. Andernfalls müssen Sie nichts tun: Am {ends} hat diese Person keinen Zugang mehr zum Bereich. Nachrichten und Dateien bleiben erhalten, und Sie können den Zugang 90 Tage lang reaktivieren."),
            "Zugang verlängern",
            "Am Vortag folgt eine letzte Erinnerung. Um diese Nachrichten nicht mehr zu erhalten, geben Sie die Verwaltung der Gäste ab.",
        ),
        Locale::It => (
            if many {
                format!("L'accesso di {guest} a {space} termina tra {days} giorni")
            } else {
                format!("L'accesso di {guest} a {space} termina domani")
            },
            format!("Ciao {reader},"),
            format!(
                "L'accesso di {guest} allo spazio {space} termina il {ends}{}. Ricevi questo messaggio perché gestisci gli ospiti di questo spazio.",
                if many { format!(", tra {days} giorni") } else { ", domani".to_owned() }
            ),
            "accesso fino al",
            format!("Se il lavoro con te continua, prolunga il suo accesso. Altrimenti non devi fare nulla: il {ends}, questa persona non avrà più accesso allo spazio. Messaggi e file restano e potrai riattivare il suo accesso per 90 giorni."),
            "Prolunga l'accesso",
            "Riceverai un ultimo promemoria il giorno prima. Per non ricevere più questi messaggi, smetti di gestire gli ospiti.",
        ),
        Locale::Pl => (
            if many {
                format!("Dostęp użytkownika {guest} do {space} kończy się za {days} dni")
            } else {
                format!("Dostęp użytkownika {guest} do {space} kończy się jutro")
            },
            format!("Cześć {reader},"),
            format!(
                "Dostęp użytkownika {guest} do przestrzeni {space} kończy się {ends}{}. Dostajesz tę wiadomość, bo zarządzasz gośćmi tej przestrzeni.",
                if many { format!(", za {days} dni") } else { ", jutro".to_owned() }
            ),
            "dostęp do",
            format!("Jeśli współpraca trwa, przedłuż dostęp. W przeciwnym razie nic nie musisz robić: {ends} ta osoba straci dostęp do przestrzeni. Wiadomości i pliki zostają, a dostęp możesz przywrócić w ciągu 90 dni."),
            "Przedłuż dostęp",
            "Ostatnie przypomnienie przyjdzie dzień wcześniej. Aby nie dostawać tych wiadomości, przestań zarządzać gośćmi.",
        ),
    };
    let access = format!("{until} {ends}");
    let detail = match words.title.filter(|title| !title.trim().is_empty()) {
        Some(title) => format!("{title} \u{b7} {access}"),
        None => access,
    };
    render_extra(
        locale,
        &Content {
            subject: subject.clone(),
            preheader: subject.clone(),
            heading: subject,
            paragraph,
            button: button.to_owned(),
            link: words.link.to_owned(),
            note: note.to_owned(),
            items: Vec::new(),
        },
        instance,
        None,
        &Extra {
            greeting: Some(greeting),
            bold: Some(ends.to_owned()),
            card: Some((guest.to_owned(), detail)),
            after: Some(after),
        },
    )
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

// Ruchoir's visual identity, as the website draws it (`ruchoir-website/app/site.css`) and the
// design system names it (`packages/design-system`): cool greys, ink borders, flat offset shadows in
// pastel, terracotta for the brand's dot. Mail clients read no custom properties, so the values are
// written out. Clients that drop `box-shadow` (Gmail) show the same bordered cards, unshadowed.
const BG: &str = "#f6f7f9";
const CARD: &str = "#fdfdfe";
const LINE: &str = "#e2e5ea";
const INK: &str = "#15171c";
const BODY: &str = "#2e323a";
const MUTED: &str = "#5a6070";
const TERRACOTTA: &str = "#c65d45";
const SKY: &str = "#8fd0ff";
const BEE: &str = "#fbbf1a";
const LIME: &str = "#8fe6a3";
// The night palette (`packages/design-system/styles/tokens.css`, `[data-theme$="-dark"]`), applied by
// the reader's client when it is in dark mode. Pastels stay light, with the dark ink on them.
const NIGHT_BG: &str = "#15171c";
const NIGHT_SURFACE: &str = "#1d2027";
const NIGHT_LINE: &str = "#2e323a";
const NIGHT_INK: &str = "#f6f7f9";
const NIGHT_BODY: &str = "#dfe2e7";
const NIGHT_MUTED: &str = "#a7adb8";
/// The digest's entries take these shadows in turn, as the website's steps do.
const PASTELS: [&str; 3] = ["#6fe0c2", "#ffb3ba", "#f5b0f0"];
const FONT: &str = "'IBM Plex Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO: &str = "'IBM Plex Mono', Menlo, Consolas, monospace";

/// Draw a message twice, as HTML and as plain text, from the same content.
fn render(locale: Locale, content: &Content, instance: &str) -> Email {
    render_with_code(locale, content, instance, None)
}

/// [`render`], with a code to type shown under the button (the address confirmation).
fn render_with_code(
    locale: Locale,
    content: &Content,
    instance: &str,
    code: Option<&str>,
) -> Email {
    render_extra(locale, content, instance, code, &Extra::default())
}

/// What a message may carry beyond the common layout: a greeting, a word in bold, a card about a
/// person, a paragraph after the card. Empty for every message but the guest reminder.
#[derive(Default)]
struct Extra {
    /// "Bonjour Sophie,", above the paragraph.
    greeting: Option<String>,
    /// A part of the paragraph to set in bold (the date).
    bold: Option<String>,
    /// A card between the paragraph and what follows: a name, and a line under it.
    card: Option<(String, String)>,
    /// A paragraph after the card.
    after: Option<String>,
}

fn render_extra(
    locale: Locale,
    content: &Content,
    instance: &str,
    code: Option<&str>,
    extra: &Extra,
) -> Email {
    let common = common(locale);
    let items_text: String = content
        .items
        .iter()
        .map(|item| {
            if item.excerpt.is_empty() {
                format!("- {}\n", item.headline)
            } else {
                format!("- {}\n  {}\n", item.headline, item.excerpt)
            }
        })
        .collect();
    let paragraph_text = if items_text.is_empty() {
        content.paragraph.clone()
    } else {
        format!("{}\n\n{}", content.paragraph, items_text.trim_end())
    };
    let paragraph_text = match &extra.greeting {
        Some(greeting) => format!("{greeting}\n\n{paragraph_text}"),
        None => paragraph_text,
    };
    let paragraph_text = match &extra.card {
        Some((name, detail)) => format!("{paragraph_text}\n\n{name}\n{detail}"),
        None => paragraph_text,
    };
    let paragraph_text = match &extra.after {
        Some(after) => format!("{paragraph_text}\n\n{after}"),
        None => paragraph_text,
    };
    // A message with nothing to open (a cancellation sent outside) has no button.
    let action_text = if content.link.is_empty() {
        String::new()
    } else {
        format!("{} :\n{}\n\n", content.button, content.link)
    };
    let code_text = code
        .map(|code| format!("{}\n{}\n\n", code_label(locale), grouped_code(code)))
        .unwrap_or_default();
    let text = format!(
        "{heading}\n\n{paragraph}\n\n{action_text}{code_text}{note}\n\n-- \nRuchoir. {tagline}\n{sent_by} {instance}",
        heading = content.heading,
        paragraph = paragraph_text,
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
    // The digest's lines: one card per entry, a headline over its excerpt, each with its pastel shadow.
    let items_html = if content.items.is_empty() {
        String::new()
    } else {
        let last = content.items.len() - 1;
        let rows: String = content
            .items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let gap = if index == last { "0" } else { "14px" };
                let shadow = PASTELS[index % PASTELS.len()];
                let excerpt = if item.excerpt.is_empty() {
                    String::new()
                } else {
                    format!(
                        r#"<br><span class="rc-body" style="font-size:14px;font-weight:400;color:{BODY};">{}</span>"#,
                        esc(&item.excerpt)
                    )
                };
                format!(
                    r#"<tr><td style="padding:0 6px {gap} 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="rc-surface" style="border:2px solid {INK};border-radius:10px;background:{CARD};box-shadow:6px 6px 0 {shadow};"><tr><td class="rc-ink" style="padding:14px 16px;font-family:{FONT};font-size:15px;line-height:1.45;font-weight:600;color:{INK};">{headline}{excerpt}</td></tr></table></td></tr>"#,
                    headline = esc(&item.headline),
                )
            })
            .collect();
        format!(
            r#"<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 32px 0;">{rows}</table>"#
        )
    };
    let action_html = if content.link.is_empty() {
        String::new()
    } else {
        format!(
            r#"<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" class="rc-button-table"><tr>
<td align="center" bgcolor="{INK}" class="rc-button" style="border:2px solid {INK};border-radius:10px;box-shadow:4px 4px 0 {BEE};">
<a href="{link}" target="_blank" class="rc-button-link" style="display:inline-block;padding:14px 28px;font-family:{FONT};font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">{button}</a>
</td></tr></table>
<p class="rc-muted" style="margin:28px 0 6px 0;font-family:{FONT};font-size:13px;line-height:1.5;color:{MUTED};text-align:center;">{fallback}</p>
<p style="margin:0 0 24px 0;font-family:{MONO};font-size:13px;line-height:1.5;word-break:break-all;text-align:center;"><a href="{link}" target="_blank" class="rc-ink" style="color:{INK};text-decoration:underline;">{link}</a></p>
"#,
            button = esc(&content.button),
            fallback = esc(common.fallback),
        )
    };
    let code_html = code
        .map(|code| {
            format!(
                r#"<p class="rc-muted" style="margin:0 0 10px 0;font-family:{FONT};font-size:13px;line-height:1.5;color:{MUTED};text-align:center;">{label}</p>
<p style="margin:0 0 24px 0;text-align:center;"><span style="display:inline-block;padding:10px 20px;border:2px solid {INK};border-radius:10px;background:{LIME};font-family:{MONO};font-size:30px;line-height:1.2;font-weight:700;letter-spacing:0.08em;color:{INK};">{code}</span></p>
"#,
                label = esc(code_label(locale)),
                code = esc(&grouped_code(code)),
            )
        })
        .unwrap_or_default();
    let greeting_html = extra
        .greeting
        .as_ref()
        .map(|greeting| {
            format!(
                r#"<p class="rc-ink" style="margin:0 0 14px 0;font-family:{FONT};font-size:16px;line-height:1.6;color:{INK};">{}</p>"#,
                esc(greeting)
            )
        })
        .unwrap_or_default();
    let mut paragraph_html = esc(&content.paragraph);
    if let Some(bold) = &extra.bold {
        let marked = esc(bold);
        paragraph_html = paragraph_html.replacen(
            &marked,
            &format!(r#"<strong class="rc-ink" style="color:{INK};">{marked}</strong>"#),
            1,
        );
    }
    let card_html = extra
        .card
        .as_ref()
        .map(|(name, detail)| {
            let initials: String = name
                .split_whitespace()
                .filter_map(|word| word.chars().next())
                .take(2)
                .flat_map(char::to_uppercase)
                .collect();
            format!(
                r#"<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="rc-surface" style="margin:0 0 20px 0;border:1px solid {LINE};border-radius:12px;background:{CARD};"><tr><td width="44" style="padding:14px 0 14px 16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" width="40" height="40" style="width:40px;height:40px;border-radius:20px;background:{SKY};font-family:{FONT};font-size:14px;font-weight:700;color:{INK};">{initials}</td></tr></table></td><td style="padding:14px 16px 14px 12px;font-family:{FONT};"><span class="rc-ink" style="display:block;font-size:16px;font-weight:700;color:{INK};">{name}</span><span class="rc-muted" style="display:block;font-size:14px;line-height:1.4;color:{MUTED};">{detail}</span></td></tr></table>"#,
                initials = esc(&initials),
                name = esc(name),
                detail = esc(detail),
            )
        })
        .unwrap_or_default();
    let after_html = extra
        .after
        .as_ref()
        .map(|after| {
            format!(
                r#"<p class="rc-body" style="margin:0 0 28px 0;font-family:{FONT};font-size:16px;line-height:1.6;color:{BODY};">{}</p>"#,
                esc(after)
            )
        })
        .unwrap_or_default();
    let html = format!(
        r#"<!DOCTYPE html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>{subject}</title>
<style>
:root {{ color-scheme: light dark; supported-color-schemes: light dark; }}
@media (max-width: 480px) {{
  .rc-outer {{ padding: 24px 12px !important; }}
  .rc-card {{ padding: 28px 20px 24px 20px !important; }}
  .rc-title {{ font-size: 22px !important; }}
}}
@media (prefers-color-scheme: dark) {{
  .rc-bg {{ background: {NIGHT_BG} !important; }}
  .rc-surface {{ background: {NIGHT_SURFACE} !important; border-color: {NIGHT_INK} !important; }}
  .rc-ink {{ color: {NIGHT_INK} !important; }}
  .rc-body {{ color: {NIGHT_BODY} !important; }}
  .rc-muted {{ color: {NIGHT_MUTED} !important; }}
  .rc-line {{ border-top-color: {NIGHT_LINE} !important; }}
  .rc-button {{ background: {NIGHT_INK} !important; border-color: {NIGHT_INK} !important; }}
  .rc-button-link {{ color: {INK} !important; }}
}}
/* Outlook.com and the Outlook apps mark their dark mode with these attributes instead. */
[data-ogsb] .rc-bg {{ background: {NIGHT_BG} !important; }}
[data-ogsb] .rc-surface {{ background: {NIGHT_SURFACE} !important; }}
[data-ogsc] .rc-ink {{ color: {NIGHT_INK} !important; }}
[data-ogsc] .rc-body {{ color: {NIGHT_BODY} !important; }}
[data-ogsc] .rc-muted {{ color: {NIGHT_MUTED} !important; }}
</style>
</head>
<body class="rc-bg" style="margin:0;padding:0;background:{BG};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">{preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="rc-bg" style="background:{BG};">
<tr><td align="center" class="rc-outer" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td align="center" style="padding:0 0 28px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
<td style="vertical-align:middle;"><img src="cid:{LOGO_CID}" width="40" height="40" alt="" style="display:block;border:0;"></td>
<td class="rc-ink" style="vertical-align:middle;padding-left:10px;font-family:{FONT};font-size:22px;font-weight:700;letter-spacing:-0.02em;color:{INK};">Ruchoir<span style="color:{TERRACOTTA};">.</span></td>
</tr></table>
</td></tr>
<tr><td style="padding:0 8px 8px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="rc-surface" style="border:2px solid {INK};border-radius:16px;background:{CARD};box-shadow:8px 8px 0 {SKY};">
<tr><td class="rc-card" style="padding:36px 32px 32px 32px;">
<h1 class="rc-title rc-ink" style="margin:0 0 12px 0;font-family:{FONT};font-size:26px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:{INK};">{heading}</h1>
{greeting_html}<p class="rc-body" style="margin:0 0 {paragraph_gap};font-family:{FONT};font-size:16px;line-height:1.6;color:{BODY};">{paragraph}</p>
{card_html}{after_html}{items_html}
{action_html}{code_html}<p class="rc-muted rc-line" style="margin:0;padding-top:20px;border-top:1px solid {LINE};font-family:{FONT};font-size:13px;line-height:1.55;color:{MUTED};text-align:center;">{note}</p>
</td></tr></table>
</td></tr>
<tr><td align="center" class="rc-muted" style="padding:28px 16px 0 16px;font-family:{FONT};font-size:12px;line-height:1.6;color:{MUTED};">
<span class="rc-ink" style="color:{INK};font-weight:700;">Ruchoir.</span> {tagline}<br>
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
        paragraph = paragraph_html,
        paragraph_gap = if extra.card.is_some() { "16px" } else { "28px" },
        note = esc(&content.note),
        tagline = esc(common.tagline),
        sent_by = esc(common.sent_by),
        instance = esc(instance),
    );

    Email {
        subject: content.subject.clone(),
        text,
        html,
        calendar: None,
    }
}

/// What an invitation mail is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvitationMail {
    /// Someone was invited.
    Invited,
    /// The event's time or place changed.
    Updated,
    /// It was cancelled, or the reader taken off its list.
    Cancelled,
    /// An attendee declined (to the organiser).
    Declined,
}

/// The words of an invitation mail, filled in.
#[derive(Clone)]
pub struct InvitationWords<'a> {
    pub kind: InvitationMail,
    /// Who did it: the organiser, or the attendee who declined.
    pub actor: &'a str,
    pub title: &'a str,
    /// "20/10 10:00", in the reader's language and zone.
    pub when: &'a str,
    pub location: Option<&'a str>,
    /// Where the button leads: the calendar for a member, the answer page for someone outside; empty
    /// for no button.
    pub link: &'a str,
    /// Whether the reader has no account (answers through the link, adds the attached file).
    pub external: bool,
}

/// Fill `{actor}`, `{title}`, `{when}`, `{place}`.
fn fill(template: &str, words: &InvitationWords<'_>, place: &str) -> String {
    template
        .replace("{actor}", words.actor)
        .replace("{title}", words.title)
        .replace("{when}", words.when)
        .replace("{place}", place)
}

/// The subject (and push title) of an invitation kind: "Invitation : Revue".
pub fn invitation_subject(
    locale: Locale,
    kind: InvitationMail,
    actor: &str,
    title: &str,
) -> String {
    let template = match (locale, kind) {
        (Locale::Fr, InvitationMail::Invited) => "Invitation\u{a0}: {title}",
        (Locale::Fr, InvitationMail::Updated) => "Modifié\u{a0}: {title}",
        (Locale::Fr, InvitationMail::Cancelled) => "Annulé\u{a0}: {title}",
        (Locale::Fr, InvitationMail::Declined) => "{actor} a refusé\u{a0}: {title}",
        (Locale::En, InvitationMail::Invited) => "Invitation: {title}",
        (Locale::En, InvitationMail::Updated) => "Changed: {title}",
        (Locale::En, InvitationMail::Cancelled) => "Cancelled: {title}",
        (Locale::En, InvitationMail::Declined) => "{actor} declined: {title}",
        (Locale::Es, InvitationMail::Invited) => "Invitación: {title}",
        (Locale::Es, InvitationMail::Updated) => "Modificado: {title}",
        (Locale::Es, InvitationMail::Cancelled) => "Cancelado: {title}",
        (Locale::Es, InvitationMail::Declined) => "{actor} ha rechazado: {title}",
        (Locale::De, InvitationMail::Invited) => "Einladung: {title}",
        (Locale::De, InvitationMail::Updated) => "Geändert: {title}",
        (Locale::De, InvitationMail::Cancelled) => "Abgesagt: {title}",
        (Locale::De, InvitationMail::Declined) => "{actor} hat abgelehnt: {title}",
        (Locale::It, InvitationMail::Invited) => "Invito: {title}",
        (Locale::It, InvitationMail::Updated) => "Modificato: {title}",
        (Locale::It, InvitationMail::Cancelled) => "Annullato: {title}",
        (Locale::It, InvitationMail::Declined) => "{actor} ha rifiutato: {title}",
        (Locale::Pl, InvitationMail::Invited) => "Zaproszenie: {title}",
        (Locale::Pl, InvitationMail::Updated) => "Zmiana: {title}",
        (Locale::Pl, InvitationMail::Cancelled) => "Odwołane: {title}",
        (Locale::Pl, InvitationMail::Declined) => "{actor} odrzuca: {title}",
    };
    template.replace("{actor}", actor).replace("{title}", title)
}

/// An invitation, a change, a cancellation or a refusal, by mail.
pub fn calendar_invitation(locale: Locale, words: &InvitationWords<'_>, instance: &str) -> Email {
    use InvitationMail::{Cancelled, Declined, Invited, Updated};
    let place = words
        .location
        .map(|l| format!(" · {l}"))
        .unwrap_or_default();
    let paragraph = match (locale, words.kind) {
        (Locale::Fr, Invited) => "{actor} vous invite à «\u{a0}{title}\u{a0}», {when}{place}.",
        (Locale::Fr, Updated) => {
            "{actor} a modifié «\u{a0}{title}\u{a0}»\u{a0}: c'est maintenant {when}{place}."
        }
        (Locale::Fr, Cancelled) => "{actor} a annulé «\u{a0}{title}\u{a0}» ({when}).",
        (Locale::Fr, Declined) => {
            "{actor} a refusé votre invitation à «\u{a0}{title}\u{a0}» ({when})."
        }
        (Locale::En, Invited) => "{actor} invites you to \u{201c}{title}\u{201d}, {when}{place}.",
        (Locale::En, Updated) => {
            "{actor} changed \u{201c}{title}\u{201d}: it is now {when}{place}."
        }
        (Locale::En, Cancelled) => "{actor} cancelled \u{201c}{title}\u{201d} ({when}).",
        (Locale::En, Declined) => {
            "{actor} declined your invitation to \u{201c}{title}\u{201d} ({when})."
        }
        (Locale::Es, Invited) => "{actor} te invita a «{title}», {when}{place}.",
        (Locale::Es, Updated) => "{actor} ha modificado «{title}»: ahora es {when}{place}.",
        (Locale::Es, Cancelled) => "{actor} ha cancelado «{title}» ({when}).",
        (Locale::Es, Declined) => "{actor} ha rechazado tu invitación a «{title}» ({when}).",
        (Locale::De, Invited) => "{actor} lädt Sie zu \u{201e}{title}\u{201c} ein, {when}{place}.",
        (Locale::De, Updated) => {
            "{actor} hat \u{201e}{title}\u{201c} geändert: jetzt {when}{place}."
        }
        (Locale::De, Cancelled) => "{actor} hat \u{201e}{title}\u{201c} abgesagt ({when}).",
        (Locale::De, Declined) => {
            "{actor} hat Ihre Einladung zu \u{201e}{title}\u{201c} abgelehnt ({when})."
        }
        (Locale::It, Invited) => "{actor} ti invita a «{title}», {when}{place}.",
        (Locale::It, Updated) => "{actor} ha modificato «{title}»: ora è {when}{place}.",
        (Locale::It, Cancelled) => "{actor} ha annullato «{title}» ({when}).",
        (Locale::It, Declined) => "{actor} ha rifiutato il tuo invito a «{title}» ({when}).",
        (Locale::Pl, Invited) => "{actor} zaprasza Cię na \u{201e}{title}\u{201d}, {when}{place}.",
        (Locale::Pl, Updated) => "{actor} zmienia \u{201e}{title}\u{201d}: teraz {when}{place}.",
        (Locale::Pl, Cancelled) => "{actor} odwołuje \u{201e}{title}\u{201d} ({when}).",
        (Locale::Pl, Declined) => {
            "{actor} odrzuca Twoje zaproszenie na \u{201e}{title}\u{201d} ({when})."
        }
    };
    let (open, reply) = match locale {
        Locale::Fr => ("Ouvrir l'agenda", "Répondre"),
        Locale::En => ("Open the calendar", "Reply"),
        Locale::Es => ("Abrir el calendario", "Responder"),
        Locale::De => ("Kalender öffnen", "Antworten"),
        Locale::It => ("Apri il calendario", "Rispondi"),
        Locale::Pl => ("Otwórz kalendarz", "Odpowiedz"),
    };
    let note = if words.external {
        match locale {
            Locale::Fr => "{actor} vous écrit depuis Ruchoir. Le fichier joint met votre agenda à jour.",
            Locale::En => "{actor} is writing to you from Ruchoir. The attached file updates your calendar.",
            Locale::Es => "{actor} te escribe desde Ruchoir. El archivo adjunto actualiza tu calendario.",
            Locale::De => "{actor} schreibt Ihnen über Ruchoir. Die angehängte Datei aktualisiert Ihren Kalender.",
            Locale::It => "{actor} ti scrive da Ruchoir. Il file allegato aggiorna il tuo calendario.",
            Locale::Pl => "{actor} pisze do Ciebie z Ruchoir. Załączony plik aktualizuje Twój kalendarz.",
        }
    } else {
        match locale {
            Locale::Fr => "Vous recevez cet e-mail parce que Ruchoir n'était ouvert nulle part. Pour ne plus en recevoir, désactivez «\u{a0}Invitations d'agenda\u{a0}» par e-mail dans Préférences > Notifications.",
            Locale::En => "You are receiving this email because Ruchoir was not open anywhere. To stop them, turn off \u{201c}Calendar invitations\u{201d} by email in Preferences > Notifications.",
            Locale::Es => "Recibes este correo porque Ruchoir no estaba abierto en ningún sitio. Para dejar de recibirlos, desactiva «Invitaciones de agenda» por correo en Preferencias > Notificaciones.",
            Locale::De => "Sie erhalten diese E-Mail, weil Ruchoir nirgends geöffnet war. Um keine mehr zu erhalten, deaktivieren Sie \u{201e}Kalendereinladungen\u{201c} per E-Mail unter Einstellungen > Benachrichtigungen.",
            Locale::It => "Ricevi questa e-mail perché Ruchoir non era aperto da nessuna parte. Per non riceverne più, disattiva «Inviti del calendario» per e-mail in Preferenze > Notifiche.",
            Locale::Pl => "Otrzymujesz tę wiadomość, ponieważ Ruchoir nie był nigdzie otwarty. Aby ich nie otrzymywać, wyłącz \u{201e}Zaproszenia z kalendarza\u{201d} przez e-mail w Preferencje > Powiadomienia.",
        }
    };
    let content = Content {
        subject: invitation_subject(locale, words.kind, words.actor, words.title),
        preheader: format!("{}{place}", words.when),
        heading: words.title.to_owned(),
        paragraph: fill(paragraph, words, &place),
        button: if words.external { reply } else { open }.to_owned(),
        link: words.link.to_owned(),
        note: fill(note, words, &place),
        items: Vec::new(),
    };
    render(locale, &content, instance)
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
                "123456",
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
            unread_digest(
                locale,
                vec![
                    DigestItem {
                        headline: format!(
                            "Camille Roussel {} · #général",
                            notification_verb(locale, "mention")
                        ),
                        excerpt: "@Théo tu peux relire la maquette avant demain ?".to_owned(),
                    },
                    DigestItem {
                        headline: format!("Léa Martin {}", notification_verb(locale, "dm")),
                        excerpt: "Le devis est parti, je te tiens au courant.".to_owned(),
                    },
                ],
                5,
                &format!("{base}/"),
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

/// A local date as people write it, short: `26/10` in French, `10/26` in English.
pub fn short_date(locale: Locale, date: time::Date) -> String {
    let (day, month) = (date.day(), u8::from(date.month()));
    match locale {
        Locale::En => format!("{month}/{day}"),
        Locale::De | Locale::Pl => format!("{day:02}.{month:02}."),
        Locale::Fr | Locale::Es | Locale::It => format!("{day:02}/{month:02}"),
    }
}

/// How soon a reminded event starts, as a reminder's first words: "In 10 min", "Tomorrow".
///
/// `minutes` is how long until it starts (a timed event); `day` tells an all-day event happening
/// today from one happening tomorrow.
pub fn reminder_lead(locale: Locale, minutes: i64, day: ReminderDay) -> String {
    let hours = (minutes + 30) / 60;
    match (locale, day) {
        (Locale::Fr, ReminderDay::Today) => "Aujourd'hui".to_owned(),
        (Locale::Fr, ReminderDay::Tomorrow) => "Demain".to_owned(),
        (Locale::En, ReminderDay::Today) => "Today".to_owned(),
        (Locale::En, ReminderDay::Tomorrow) => "Tomorrow".to_owned(),
        (Locale::Es, ReminderDay::Today) => "Hoy".to_owned(),
        (Locale::Es, ReminderDay::Tomorrow) => "Mañana".to_owned(),
        (Locale::De, ReminderDay::Today) => "Heute".to_owned(),
        (Locale::De, ReminderDay::Tomorrow) => "Morgen".to_owned(),
        (Locale::It, ReminderDay::Today) => "Oggi".to_owned(),
        (Locale::It, ReminderDay::Tomorrow) => "Domani".to_owned(),
        (Locale::Pl, ReminderDay::Today) => "Dziś".to_owned(),
        (Locale::Pl, ReminderDay::Tomorrow) => "Jutro".to_owned(),
        (_, ReminderDay::Timed) if minutes >= 1440 => {
            reminder_lead(locale, 0, ReminderDay::Tomorrow)
        }
        (Locale::Fr, ReminderDay::Timed) if minutes <= 0 => "Maintenant".to_owned(),
        (Locale::Fr, ReminderDay::Timed) if minutes < 60 => format!("Dans {minutes}\u{a0}min"),
        (Locale::Fr, ReminderDay::Timed) => format!("Dans {hours}\u{a0}h"),
        (Locale::En, ReminderDay::Timed) if minutes <= 0 => "Now".to_owned(),
        (Locale::En, ReminderDay::Timed) if minutes < 60 => format!("In {minutes} min"),
        (Locale::En, ReminderDay::Timed) => format!("In {hours} h"),
        (Locale::Es, ReminderDay::Timed) if minutes <= 0 => "Ahora".to_owned(),
        (Locale::Es, ReminderDay::Timed) if minutes < 60 => format!("En {minutes} min"),
        (Locale::Es, ReminderDay::Timed) => format!("En {hours} h"),
        (Locale::De, ReminderDay::Timed) if minutes <= 0 => "Jetzt".to_owned(),
        (Locale::De, ReminderDay::Timed) if minutes < 60 => format!("In {minutes} Min."),
        (Locale::De, ReminderDay::Timed) => format!("In {hours} Std."),
        (Locale::It, ReminderDay::Timed) if minutes <= 0 => "Ora".to_owned(),
        (Locale::It, ReminderDay::Timed) if minutes < 60 => format!("Tra {minutes} min"),
        (Locale::It, ReminderDay::Timed) => format!("Tra {hours} h"),
        (Locale::Pl, ReminderDay::Timed) if minutes <= 0 => "Teraz".to_owned(),
        (Locale::Pl, ReminderDay::Timed) if minutes < 60 => format!("Za {minutes} min"),
        (Locale::Pl, ReminderDay::Timed) => format!("Za {hours} godz."),
    }
}

/// What kind of moment a reminder announces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReminderDay {
    Timed,
    Today,
    Tomorrow,
}

/// A reminder's title line: "Dans 10 min : Point équipe", with the French space before the colon.
pub fn reminder_title(locale: Locale, lead: &str, title: &str) -> String {
    match locale {
        Locale::Fr => format!("{lead}\u{a0}: {title}"),
        _ => format!("{lead}: {title}"),
    }
}

/// A calendar reminder by mail, for someone who has no Ruchoir open.
///
/// `when` is the occurrence's local date and time as the reader writes them, `lead` how soon it
/// is ("Dans 10 min").
pub fn calendar_reminder(
    locale: Locale,
    lead: &str,
    title: &str,
    when: &str,
    location: Option<&str>,
    link: &str,
    instance: &str,
) -> Email {
    let link = link.to_owned();
    let place = location.map(|l| format!(" · {l}")).unwrap_or_default();
    let subject = reminder_title(locale, lead, title);
    let content = match locale {
        Locale::Fr => Content {
            subject,
            preheader: format!("{when}{place}"),
            heading: title.to_owned(),
            paragraph: format!("{lead}, {when}{place}."),
            button: "Ouvrir le calendrier".to_owned(),
            link,
            note: "Vous recevez cet e-mail parce que vous avez un rappel pour cet événement et que Ruchoir n'était ouvert nulle part. Pour ne plus en recevoir, désactivez «\u{a0}Rappels d'agenda\u{a0}» par e-mail dans Préférences > Notifications.".to_owned(),
            items: Vec::new(),
        },
        Locale::En => Content {
            subject,
            preheader: format!("{when}{place}"),
            heading: title.to_owned(),
            paragraph: format!("{lead}, {when}{place}."),
            button: "Open the calendar".to_owned(),
            link,
            note: "You are receiving this email because you have a reminder for this event and Ruchoir was not open anywhere. To stop them, turn off \u{201c}Calendar reminders\u{201d} by email in Preferences > Notifications.".to_owned(),
            items: Vec::new(),
        },
        Locale::Es => Content {
            subject,
            preheader: format!("{when}{place}"),
            heading: title.to_owned(),
            paragraph: format!("{lead}, {when}{place}."),
            button: "Abrir el calendario".to_owned(),
            link,
            note: "Recibes este correo porque tienes un recordatorio para este evento y Ruchoir no estaba abierto en ningún sitio. Para dejar de recibirlos, desactiva «Recordatorios de agenda» por correo en Preferencias > Notificaciones.".to_owned(),
            items: Vec::new(),
        },
        Locale::De => Content {
            subject,
            preheader: format!("{when}{place}"),
            heading: title.to_owned(),
            paragraph: format!("{lead}, {when}{place}."),
            button: "Kalender öffnen".to_owned(),
            link,
            note: "Sie erhalten diese E-Mail, weil Sie eine Erinnerung für diesen Termin haben und Ruchoir nirgends geöffnet war. Um keine mehr zu erhalten, deaktivieren Sie \u{201e}Kalendererinnerungen\u{201c} per E-Mail unter Einstellungen > Benachrichtigungen.".to_owned(),
            items: Vec::new(),
        },
        Locale::It => Content {
            subject,
            preheader: format!("{when}{place}"),
            heading: title.to_owned(),
            paragraph: format!("{lead}, {when}{place}."),
            button: "Apri il calendario".to_owned(),
            link,
            note: "Ricevi questa e-mail perché hai un promemoria per questo evento e Ruchoir non era aperto da nessuna parte. Per non riceverne più, disattiva «Promemoria del calendario» via e-mail in Preferenze > Notifiche.".to_owned(),
            items: Vec::new(),
        },
        Locale::Pl => Content {
            subject,
            preheader: format!("{when}{place}"),
            heading: title.to_owned(),
            paragraph: format!("{lead}, {when}{place}."),
            button: "Otwórz kalendarz".to_owned(),
            link,
            note: "Otrzymujesz tę wiadomość, ponieważ masz przypomnienie o tym wydarzeniu, a Ruchoir nie był nigdzie otwarty. Aby ich nie otrzymywać, wyłącz e-mailowe „Przypomnienia z kalendarza” w Preferencje > Powiadomienia.".to_owned(),
            items: Vec::new(),
        },
    };
    render(locale, &content, instance)
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
    fn a_notice_written_elsewhere_is_drawn_and_escaped() {
        let email = notice(
            Locale::Fr,
            &Notice {
                subject: "La licence expire bientôt",
                preheader: "Dans 7 jours",
                heading: "Plus que 7 jours",
                paragraph: "La licence de <Atelier> expire le 31 décembre.",
                button: "Ouvrir la licence",
                link: "https://app.example/e/atelier/licence",
                note: "Rien ne sera retiré.",
            },
            "app.example",
        );
        assert_eq!(email.subject, "La licence expire bientôt");
        assert!(email
            .text
            .contains("La licence de <Atelier> expire le 31 décembre."));
        assert!(email.text.contains("https://app.example/e/atelier/licence"));
        assert!(email.html.contains("La licence de &lt;Atelier&gt; expire"));
        assert!(!email.html.contains("<Atelier>"));
        assert!(email.html.contains("Ouvrir la licence"));
        assert!(email.html.contains("Rien ne sera retiré."));
    }

    #[test]
    fn a_guest_expiry_reminder_speaks_every_language_and_says_vous() {
        let words = GuestExpiryWords {
            reader: "Sophie",
            guest: "Inès Garnier",
            title: Some("Bureau d'études Garnier"),
            space: "Atelier Dupont",
            ends: "20 novembre 2026",
            days: 7,
            link: "https://app.example.test/e/atelier?prolong=1",
        };
        let fr = guest_expiry_reminder(Locale::Fr, &words, "app.example.test");
        assert_eq!(
            fr.subject,
            "L'accès de Inès Garnier à Atelier Dupont se termine dans 7 jours"
        );
        assert!(fr.text.contains("Vous recevez"), "{}", fr.text);
        assert!(fr
            .text
            .contains("https://app.example.test/e/atelier?prolong=1"));
        let eve = GuestExpiryWords { days: 1, ..words };
        assert!(guest_expiry_reminder(Locale::Fr, &eve, "x")
            .subject
            .ends_with("se termine demain"));
        let mut subjects = std::collections::HashSet::new();
        for locale in [
            Locale::Fr,
            Locale::En,
            Locale::Es,
            Locale::De,
            Locale::It,
            Locale::Pl,
        ] {
            let mail = guest_expiry_reminder(locale, &words, "x");
            assert!(mail.text.contains("Inès Garnier"), "{locale}");
            assert!(mail.html.contains("Atelier Dupont"), "{locale}");
            subjects.insert(mail.subject);
        }
        assert_eq!(subjects.len(), 6, "one text per language");
    }

    #[test]
    fn the_reminder_greets_shows_the_guest_card_and_never_guesses_a_gender() {
        let words = GuestExpiryWords {
            reader: "Sophie",
            guest: "Inès Garnier",
            title: Some("Bureau d'études Garnier"),
            space: "Atelier Dupont",
            ends: "20 novembre 2026",
            days: 7,
            link: "https://app.example.test/e/atelier?prolong=abc",
        };
        let mail = guest_expiry_reminder(Locale::Fr, &words, "app.example.test");
        assert!(mail.html.contains("Bonjour Sophie,"), "{}", mail.html);
        assert!(mail.text.contains("Bonjour Sophie,"));
        assert!(mail
            .html
            .contains("<strong class=\"rc-ink\" style=\"color:#15171c;\">20 novembre 2026</strong>, dans 7 jours"));
        assert!(mail
            .html
            .contains("Bureau d&#39;études Garnier \u{b7} accès jusqu&#39;au 20 novembre 2026"));
        assert!(mail
            .html
            .contains(r#"href="https://app.example.test/e/atelier?prolong=abc""#));
        assert!(mail.html.contains("Prolonger son accès"));
        let words_only = mail.text.to_lowercase().replace(['\n', ',', '.', ':'], " ");
        for word in [" invitée ", " invité ", " elle ", " il ", " lui "] {
            assert!(!words_only.contains(word), "{word:?} in {}", mail.text);
        }
        // No title: the card keeps the end alone.
        let bare = GuestExpiryWords {
            title: None,
            ..words
        };
        let mail = guest_expiry_reminder(Locale::Fr, &bare, "x");
        assert!(
            mail.text.contains("\naccès jusqu'au 20 novembre 2026"),
            "{}",
            mail.text
        );
    }

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
                verification(
                    locale,
                    "https://x.test/v?token=LINK",
                    "042917",
                    24,
                    "x.test",
                ),
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
                // A phone in dark mode gets the night palette rather than an inverted guess.
                assert!(
                    email.html.contains("prefers-color-scheme: dark"),
                    "{locale}"
                );
                assert!(email.html.contains(r#"content="light dark""#), "{locale}");
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
    fn the_verification_carries_its_code_in_both_bodies() {
        for locale in ALL {
            let email = verification(
                locale,
                "https://x.test/v?token=LINK",
                "042917",
                24,
                "x.test",
            );
            // Grouped by three in both bodies, so it reads at a glance and types without a slip.
            assert!(email.text.contains("042 917"), "{locale}");
            assert!(email.html.contains("042 917"), "{locale}");
            assert!(email.text.contains(code_label(locale)), "{locale}");
            assert!(email.html.contains(&esc(code_label(locale))), "{locale}");
        }
        // Nothing else carries a code block.
        let reset = password_reset(Locale::Fr, "https://x.test/r?token=LINK", 30, "x.test");
        assert!(!reset.text.contains(code_label(Locale::Fr)));
    }

    #[test]
    fn the_digest_lists_what_is_waiting_and_counts_the_rest() {
        for locale in ALL {
            let email = unread_digest(
                locale,
                vec![DigestItem {
                    headline: "HEADLINE".to_owned(),
                    excerpt: "EXCERPT".to_owned(),
                }],
                4,
                "https://x.test/",
                "x.test",
            );
            for body in [&email.text, &email.html] {
                assert!(body.contains("HEADLINE"), "{locale}");
                assert!(body.contains("EXCERPT"), "{locale}");
                assert!(
                    body.contains('3'),
                    "{locale}: the three not listed are counted"
                );
            }
            assert!(email.subject.contains('4'), "{locale}");
        }
        let one = unread_digest(Locale::Fr, Vec::new(), 1, "L", "x.test");
        assert!(!one.subject.contains('1'));
    }

    #[test]
    fn a_digest_line_is_never_markup() {
        let email = unread_digest(
            Locale::En,
            vec![DigestItem {
                headline: "<b>Eve</b>".to_owned(),
                excerpt: "<img src=x onerror=alert(1)>".to_owned(),
            }],
            1,
            "L",
            "x.test",
        );
        assert!(!email.html.contains("<img src=x"));
        assert!(email.html.contains("&lt;img src=x"));
        assert!(email.html.contains("&lt;b&gt;Eve&lt;/b&gt;"));
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

    #[test]
    fn a_reminder_says_how_soon_in_the_readers_language() {
        assert_eq!(
            reminder_lead(Locale::Fr, 10, ReminderDay::Timed),
            "Dans 10\u{a0}min"
        );
        assert_eq!(
            reminder_lead(Locale::Fr, 0, ReminderDay::Timed),
            "Maintenant"
        );
        assert_eq!(
            reminder_lead(Locale::Fr, 60, ReminderDay::Timed),
            "Dans 1\u{a0}h"
        );
        assert_eq!(
            reminder_lead(Locale::Fr, 1440, ReminderDay::Timed),
            "Demain"
        );
        assert_eq!(
            reminder_lead(Locale::En, 30, ReminderDay::Timed),
            "In 30 min"
        );
        assert_eq!(
            reminder_lead(Locale::Pl, 120, ReminderDay::Timed),
            "Za 2 godz."
        );
        assert_eq!(reminder_lead(Locale::De, 0, ReminderDay::Today), "Heute");
        assert_eq!(
            reminder_title(Locale::Fr, "Dans 10\u{a0}min", "Point"),
            "Dans 10\u{a0}min\u{a0}: Point"
        );
        let date = time::Date::from_calendar_date(2026, time::Month::October, 7).unwrap();
        assert_eq!(short_date(Locale::Fr, date), "07/10");
        assert_eq!(short_date(Locale::En, date), "10/7");
        assert_eq!(short_date(Locale::De, date), "07.10.");
        let mail = calendar_reminder(
            Locale::Fr,
            "Dans 10\u{a0}min",
            "Point équipe",
            "07/10 09:00",
            Some("Salle Ouest"),
            "https://ruchoir.example",
            "ruchoir.example",
        );
        assert_eq!(mail.subject, "Dans 10\u{a0}min\u{a0}: Point équipe");
        assert!(mail.text.contains("07/10 09:00 · Salle Ouest"));
    }

    #[test]
    fn an_invitation_mail_says_who_what_and_when_and_where_to_answer() {
        let words = InvitationWords {
            kind: InvitationMail::Invited,
            actor: "Alice",
            title: "Revue",
            when: "20/10 10:00 (Europe/Paris)",
            location: Some("Salle Ouest"),
            link: "https://ruchoir.example/i/?t=abc",
            external: true,
        };
        let email = calendar_invitation(Locale::Fr, &words, "ruchoir.example");
        assert_eq!(email.subject, "Invitation\u{a0}: Revue");
        assert!(email.text.contains(
            "Alice vous invite à «\u{a0}Revue\u{a0}», 20/10 10:00 (Europe/Paris) · Salle Ouest."
        ));
        assert!(email
            .text
            .contains("Répondre :\nhttps://ruchoir.example/i/?t=abc"));
        assert!(email.html.contains("https://ruchoir.example/i/?t=abc"));
        // Every language has its words.
        for locale in [Locale::En, Locale::Es, Locale::De, Locale::It, Locale::Pl] {
            for kind in [
                InvitationMail::Invited,
                InvitationMail::Updated,
                InvitationMail::Cancelled,
                InvitationMail::Declined,
            ] {
                let email = calendar_invitation(
                    locale,
                    &InvitationWords {
                        kind,
                        ..words.clone()
                    },
                    "x",
                );
                assert!(email.text.contains("Revue"), "{locale:?} {kind:?}");
                assert!(
                    !email.text.contains('{'),
                    "{locale:?} {kind:?} left a placeholder"
                );
            }
        }
    }

    #[test]
    fn a_mail_without_a_link_has_no_button() {
        let words = InvitationWords {
            kind: InvitationMail::Cancelled,
            actor: "Alice",
            title: "Revue",
            when: "20/10",
            location: None,
            link: "",
            external: true,
        };
        let email = calendar_invitation(Locale::En, &words, "x");
        assert!(!email.text.contains("Reply"));
        assert!(!email.html.contains("rc-button-table"));
    }
}
