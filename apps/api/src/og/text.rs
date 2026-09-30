//! The words on the link preview cards, and in the tags that go with them, in the six languages the
//! server writes in.
//!
//! A card is fetched by a chat app's scraper, which says nothing about who will read it, so the
//! language is the instance's own (`RUCHOIR_DEFAULT_LOCALE`). Line breaks are part of the text:
//! a rendered SVG does not wrap, so each language sets its own lines, short enough for the card
//! (about 27 characters for the home title, which stops where the tilted card begins). After
//! changing a sentence, look at the result: `RUCHOIR_OG_DUMP=<dir> cargo test og::` writes every
//! card in every language.

use crate::auth::mail_text::Locale;

/// Every fixed sentence of the cards. Names and counts are filled in by the functions below.
pub struct Texts {
    // The home card, and the conversation drawn on it.
    pub home_title: [&'static str; 2],
    pub home_tags: [&'static str; 2],
    pub home_description: &'static str,
    pub demo_channel: &'static str,
    pub demo_messages: [&'static str; 3],
    pub demo_composer: &'static str,
    // A valid invitation.
    pub invite_kicker_anonymous: &'static str,
    pub invite_button: &'static str,
    pub invite_description: &'static str,
    // An invitation that would not be accepted.
    pub expired_kicker: &'static str,
    pub expired_title: &'static str,
    pub expired_sub: [&'static str; 2],
    pub expired_stamp: &'static str,
    // A channel or a message, and a space: both locked behind a sign-in.
    pub message_title: [&'static str; 2],
    pub message_sub: &'static str,
    pub space_title: [&'static str; 2],
    pub space_sub: &'static str,
    // A personal link from an email (address confirmation, password reset).
    pub personal_kicker: &'static str,
    pub personal_title: &'static str,
    pub personal_sub: [&'static str; 2],
    pub personal_card: &'static str,
    pub personal_warning: [&'static str; 2],
    // The status page.
    pub status_kicker: &'static str,
    pub status_ok_title: &'static str,
    pub status_ok_sub: [&'static str; 2],
    pub status_ko_title: &'static str,
    pub status_ko_sub: [&'static str; 2],
    pub status_card: &'static str,
    pub status_rows: [&'static str; 3],
    pub status_ok: &'static str,
    pub status_ko: &'static str,
}

pub fn texts(locale: Locale) -> &'static Texts {
    match locale {
        Locale::Fr => &FR,
        Locale::En => &EN,
        Locale::Es => &ES,
        Locale::De => &DE,
        Locale::It => &IT,
        Locale::Pl => &PL,
    }
}

/// "Théo invites you to join", or the sentence without a name when the account is gone.
pub fn invite_kicker(locale: Locale, inviter: Option<&str>) -> String {
    let Some(name) = inviter else {
        return texts(locale).invite_kicker_anonymous.to_owned();
    };
    match locale {
        Locale::Fr => format!("{name} vous invite à rejoindre"),
        Locale::En => format!("{name} invites you to join"),
        Locale::Es => format!("{name} te invita a unirte a"),
        Locale::De => format!("{name} lädt Sie ein in"),
        Locale::It => format!("{name} ti invita a unirti a"),
        Locale::Pl => format!("{name} zaprasza Cię do"),
    }
}

/// "12 members · 8 channels", with each language's plural.
pub fn space_counts(locale: Locale, members: u64, channels: u64) -> String {
    let (m, c) = match locale {
        Locale::Fr => (
            plural(members, "membre", "membres"),
            plural(channels, "salon", "salons"),
        ),
        Locale::En => (
            plural(members, "member", "members"),
            plural(channels, "channel", "channels"),
        ),
        Locale::Es => (
            plural(members, "miembro", "miembros"),
            plural(channels, "canal", "canales"),
        ),
        Locale::De => (
            plural(members, "Mitglied", "Mitglieder"),
            plural(channels, "Kanal", "Kanäle"),
        ),
        Locale::It => (
            plural(members, "membro", "membri"),
            plural(channels, "canale", "canali"),
        ),
        Locale::Pl => (
            polish(members, "członek", "członków", "członków"),
            polish(channels, "kanał", "kanały", "kanałów"),
        ),
    };
    format!("{members} {m} · {channels} {c}")
}

fn plural(n: u64, one: &'static str, other: &'static str) -> &'static str {
    if n == 1 {
        one
    } else {
        other
    }
}

/// Polish has three forms: 1, 2-4 (but not 12-14), and the rest.
fn polish(n: u64, one: &'static str, few: &'static str, many: &'static str) -> &'static str {
    if n == 1 {
        one
    } else if (2..=4).contains(&(n % 10)) && !(12..=14).contains(&(n % 100)) {
        few
    } else {
        many
    }
}

static FR: Texts = Texts {
    home_title: ["Vos conversations d'équipe,", "chez vous."],
    home_tags: ["Hébergé en Europe", "Open-core"],
    home_description: "Messagerie d'équipe et fichiers partagés, hébergés en Europe.",
    demo_channel: "général",
    demo_messages: [
        "La maquette est prête",
        "Je relis ce soir !",
        "On en parle au point de 14 h",
    ],
    demo_composer: "Écrire dans #général",
    invite_kicker_anonymous: "Vous êtes invité à rejoindre",
    invite_button: "Rejoindre l'espace",
    invite_description: "Rejoignez l'espace sur Ruchoir.",
    expired_kicker: "Cette invitation",
    expired_title: "n'est plus valable.",
    expired_sub: [
        "Demandez-en une nouvelle à la personne",
        "qui vous l'a envoyée.",
    ],
    expired_stamp: "EXPIRÉE",
    message_title: ["Un message", "vous attend."],
    message_sub: "Connectez-vous pour le lire.",
    space_title: ["Un espace", "vous attend."],
    space_sub: "Connectez-vous pour y entrer.",
    personal_kicker: "Lien personnel",
    personal_title: "Ne le partagez pas.",
    personal_sub: [
        "Il donne accès à un compte : seule la",
        "personne qui l'a reçu doit l'ouvrir.",
    ],
    personal_card: "Lien de connexion",
    personal_warning: ["Personne ne vous demandera", "ce lien."],
    status_kicker: "État de l'instance",
    status_ok_title: "Tout fonctionne.",
    status_ok_sub: [
        "Le serveur, les données et le temps réel",
        "répondent normalement.",
    ],
    status_ko_title: "Incident en cours.",
    status_ko_sub: ["Un service ne répond plus.", "On s'en occupe."],
    status_card: "Services",
    status_rows: ["Serveur", "Données", "Temps réel"],
    status_ok: "OK",
    status_ko: "Incident",
};

static EN: Texts = Texts {
    home_title: ["Your team's conversations,", "on your own ground."],
    home_tags: ["Hosted in Europe", "Open-core"],
    home_description: "Team messaging and shared files, hosted in Europe.",
    demo_channel: "general",
    demo_messages: [
        "The mockup is ready",
        "I'll review it tonight!",
        "Let's discuss it at the 2 pm sync",
    ],
    demo_composer: "Write in #general",
    invite_kicker_anonymous: "You are invited to join",
    invite_button: "Join the space",
    invite_description: "Join the space on Ruchoir.",
    expired_kicker: "This invitation",
    expired_title: "is no longer valid.",
    expired_sub: ["Ask the person who sent it", "for a new one."],
    expired_stamp: "EXPIRED",
    message_title: ["A message is", "waiting for you."],
    message_sub: "Sign in to read it.",
    space_title: ["A space is", "waiting for you."],
    space_sub: "Sign in to enter it.",
    personal_kicker: "Personal link",
    personal_title: "Do not share it.",
    personal_sub: [
        "It opens an account: only the person",
        "who received it should use it.",
    ],
    personal_card: "Sign-in link",
    personal_warning: ["Nobody will ever ask you", "for this link."],
    status_kicker: "Instance status",
    status_ok_title: "All systems go.",
    status_ok_sub: ["The server, the data and real time", "are all responding."],
    status_ko_title: "Ongoing incident.",
    status_ko_sub: ["A service is not responding.", "We are on it."],
    status_card: "Services",
    status_rows: ["Server", "Data", "Real time"],
    status_ok: "OK",
    status_ko: "Incident",
};

static ES: Texts = Texts {
    home_title: ["Tu equipo conversa", "en su propia casa."],
    home_tags: ["Alojado en Europa", "Open-core"],
    home_description: "Mensajería de equipo y archivos compartidos, alojados en Europa.",
    demo_channel: "general",
    demo_messages: [
        "La maqueta está lista",
        "¡La reviso esta noche!",
        "Lo vemos en la reunión de las 14 h",
    ],
    demo_composer: "Escribir en #general",
    invite_kicker_anonymous: "Te invitan a unirte a",
    invite_button: "Unirse al espacio",
    invite_description: "Únete al espacio en Ruchoir.",
    expired_kicker: "Esta invitación",
    expired_title: "ya no es válida.",
    expired_sub: ["Pide una nueva a la persona", "que te la envió."],
    expired_stamp: "CADUCADA",
    message_title: ["Un mensaje", "te espera."],
    message_sub: "Inicia sesión para leerlo.",
    space_title: ["Un espacio", "te espera."],
    space_sub: "Inicia sesión para entrar.",
    personal_kicker: "Enlace personal",
    personal_title: "No lo compartas.",
    personal_sub: [
        "Da acceso a una cuenta: solo la persona",
        "que lo recibió debe abrirlo.",
    ],
    personal_card: "Enlace de acceso",
    personal_warning: ["Nadie te pedirá", "este enlace."],
    status_kicker: "Estado de la instancia",
    status_ok_title: "Todo funciona.",
    status_ok_sub: [
        "El servidor, los datos y el tiempo real",
        "responden con normalidad.",
    ],
    status_ko_title: "Incidencia en curso.",
    status_ko_sub: ["Un servicio no responde.", "Estamos en ello."],
    status_card: "Servicios",
    status_rows: ["Servidor", "Datos", "Tiempo real"],
    status_ok: "OK",
    status_ko: "Incidencia",
};

static DE: Texts = Texts {
    home_title: ["Die Gespräche Ihres Teams,", "bei Ihnen zu Hause."],
    home_tags: ["In Europa gehostet", "Open-core"],
    home_description: "Team-Messaging und geteilte Dateien, in Europa gehostet.",
    demo_channel: "allgemein",
    demo_messages: [
        "Das Mockup ist fertig",
        "Ich schaue es heute Abend an!",
        "Besprechen wir um 14 Uhr",
    ],
    demo_composer: "In #allgemein schreiben",
    invite_kicker_anonymous: "Sie sind eingeladen in",
    invite_button: "Dem Bereich beitreten",
    invite_description: "Treten Sie dem Bereich auf Ruchoir bei.",
    expired_kicker: "Diese Einladung",
    expired_title: "ist nicht mehr gültig.",
    expired_sub: [
        "Bitten Sie die Person, die sie gesendet",
        "hat, um eine neue.",
    ],
    expired_stamp: "ABGELAUFEN",
    message_title: ["Eine Nachricht", "wartet auf Sie."],
    message_sub: "Melden Sie sich an, um sie zu lesen.",
    space_title: ["Ein Bereich", "wartet auf Sie."],
    space_sub: "Melden Sie sich an, um ihn zu öffnen.",
    personal_kicker: "Persönlicher Link",
    personal_title: "Nicht weitergeben.",
    personal_sub: [
        "Er öffnet ein Konto: Nur die Person,",
        "die ihn erhalten hat, sollte ihn nutzen.",
    ],
    personal_card: "Anmeldelink",
    personal_warning: ["Niemand wird Sie nach", "diesem Link fragen."],
    status_kicker: "Status der Instanz",
    status_ok_title: "Alles läuft.",
    status_ok_sub: ["Server, Daten und Echtzeit", "antworten normal."],
    status_ko_title: "Störung aktiv.",
    status_ko_sub: ["Ein Dienst antwortet nicht.", "Wir kümmern uns darum."],
    status_card: "Dienste",
    status_rows: ["Server", "Daten", "Echtzeit"],
    status_ok: "OK",
    status_ko: "Störung",
};

static IT: Texts = Texts {
    home_title: ["Il tuo team conversa", "a casa propria."],
    home_tags: ["Ospitato in Europa", "Open-core"],
    home_description: "Messaggistica di team e file condivisi, ospitati in Europa.",
    demo_channel: "generale",
    demo_messages: [
        "Il mockup è pronto",
        "Lo rivedo stasera!",
        "Ne parliamo alla riunione delle 14",
    ],
    demo_composer: "Scrivi in #generale",
    invite_kicker_anonymous: "Sei invitato a unirti a",
    invite_button: "Entra nello spazio",
    invite_description: "Entra nello spazio su Ruchoir.",
    expired_kicker: "Questo invito",
    expired_title: "non è più valido.",
    expired_sub: ["Chiedine uno nuovo alla persona", "che te l'ha inviato."],
    expired_stamp: "SCADUTO",
    message_title: ["Un messaggio", "ti aspetta."],
    message_sub: "Accedi per leggerlo.",
    space_title: ["Uno spazio", "ti aspetta."],
    space_sub: "Accedi per entrare.",
    personal_kicker: "Link personale",
    personal_title: "Non condividerlo.",
    personal_sub: [
        "Apre un account: solo la persona",
        "che l'ha ricevuto deve usarlo.",
    ],
    personal_card: "Link di accesso",
    personal_warning: ["Nessuno ti chiederà mai", "questo link."],
    status_kicker: "Stato dell'istanza",
    status_ok_title: "Tutto funziona.",
    status_ok_sub: ["Server, dati e tempo reale", "rispondono normalmente."],
    status_ko_title: "Incidente in corso.",
    status_ko_sub: ["Un servizio non risponde.", "Ce ne stiamo occupando."],
    status_card: "Servizi",
    status_rows: ["Server", "Dati", "Tempo reale"],
    status_ok: "OK",
    status_ko: "Incidente",
};

static PL: Texts = Texts {
    home_title: ["Rozmowy Twojego zespołu,", "u Ciebie."],
    home_tags: ["Hostowane w Europie", "Open-core"],
    home_description: "Komunikator zespołowy i wspólne pliki, hostowane w Europie.",
    demo_channel: "ogólny",
    demo_messages: [
        "Makieta jest gotowa",
        "Przejrzę ją wieczorem!",
        "Omówmy to na spotkaniu o 14",
    ],
    demo_composer: "Napisz na #ogólny",
    invite_kicker_anonymous: "Zaproszenie do",
    invite_button: "Dołącz do przestrzeni",
    invite_description: "Dołącz do przestrzeni w Ruchoir.",
    expired_kicker: "To zaproszenie",
    expired_title: "jest już nieważne.",
    expired_sub: ["Poproś osobę, która je wysłała,", "o nowe."],
    expired_stamp: "WYGASŁO",
    message_title: ["Czeka na Ciebie", "wiadomość."],
    message_sub: "Zaloguj się, aby ją przeczytać.",
    space_title: ["Czeka na Ciebie", "przestrzeń."],
    space_sub: "Zaloguj się, aby do niej wejść.",
    personal_kicker: "Link osobisty",
    personal_title: "Nie udostępniaj go.",
    personal_sub: [
        "Otwiera konto: używać go powinna",
        "tylko osoba, która go otrzymała.",
    ],
    personal_card: "Link logowania",
    personal_warning: ["Nikt nigdy nie poprosi", "Cię o ten link."],
    status_kicker: "Stan instancji",
    status_ok_title: "Wszystko działa.",
    status_ok_sub: ["Serwer, dane i czas rzeczywisty", "odpowiadają normalnie."],
    status_ko_title: "Trwa awaria.",
    status_ko_sub: ["Jedna z usług nie odpowiada.", "Zajmujemy się tym."],
    status_card: "Usługi",
    status_rows: ["Serwer", "Dane", "Czas rzeczywisty"],
    status_ok: "OK",
    status_ko: "Awaria",
};
