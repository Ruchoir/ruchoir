# Email delivery

Ruchoir sends three kinds of message: an address confirmation, a password reset, and an invitation
addressed to someone's mailbox. **None of them is required to run an instance**: with no relay
configured, the API writes those messages to its log and the interface stops offering the flows that
would depend on one arriving (see [Deployment](deployment.md#email) for what an instance runs on in
that state). This page is about the day you want the messages to actually leave the building.

There are two ways to get there, and the honest answer is that one of them is much harder than it
looks.

## Which path is yours

| | A relay | Your own sending server |
|---|---|---|
| What it is | You hand each message to a provider's outbound server, authenticated with a username and a password | Your host talks to the recipients' mail servers itself |
| What it needs | An account and four settings | A fixed address, control of the domain's DNS, outbound port 25, and a reputation you build over time |
| Reasonable when | Almost always, and always at first | The instance already runs on infrastructure you administer, with a static address and a matching reverse DNS record |

**If the instance runs on a home connection, take a relay.** Not as a compromise: a residential
address cannot deliver mail. Consumer ISPs block outbound port 25, the address sits in blocklists
that exist precisely for consumer ranges, and its reverse DNS name belongs to the ISP rather than to
you. Messages sent from there are not bounced so much as silently dropped, which is the failure mode
you find out about when someone says they never got their invitation.

A relay is not a surrender of sovereignty either. It is one European provider, swapped for your own
server the day you have the infrastructure to run one: the only thing that changes is four values in
`.env`.

## Ruchoir ships no mail server, on purpose

There is no optional mail service in `docker-compose.yml`, and that is a decision rather than an
omission. A mail server is a long-lived, internet-facing service with its own security surface, its
own upgrade cadence, and its own operational discipline. Shipping one we do not operate would put a
service in your stack that looks supported and is not, and it would still not solve the hard part:
being accepted by the receiving side has almost nothing to do with the sending software.

If you run your own, run it as your own: [Stalwart](https://stalw.art) (Rust, AGPL) and
[Maddy](https://maddy.email) (Go, GPL) both do outbound-only sending well, and both are yours to
operate.

## Path 1: a relay

Four values, all documented in `.env.example`:

```dotenv
RUCHOIR_SMTP_HOST=smtp.example.eu
RUCHOIR_SMTP_PORT=587
RUCHOIR_SMTP_USERNAME=ruchoir@your-domain.fr
RUCHOIR_SMTP_PASSWORD=the-password-the-provider-issued
RUCHOIR_SMTP_FROM="Ruchoir <no-reply@your-domain.fr>"
```

Plus the one that is not about sending at all and breaks the messages just as thoroughly:

```dotenv
RUCHOIR_PUBLIC_BASE_URL=https://ruchoir.your-domain.fr
```

Every link in every message is built from it. Left at its development default, the confirmation and
reset links in real emails point at `localhost` and are useless to whoever receives them.

**Port 587, STARTTLS.** The API opens a plain connection and upgrades it
(`AsyncSmtpTransport::starttls_relay`), which is what 587 expects. A provider offering only implicit
TLS on port 465 will not work today; pick 587 where both are offered.

European providers, for the same reason every other dependency here is European:

| Provider | Where | Note |
|---|---|---|
| IONOS | Germany / France | An outbound relay comes with the domain, which makes it the shortest path when the domain is already there |
| Scaleway Transactional Email | France | Built for exactly this: a handful of messages, authenticated, with delivery reporting |
| Infomaniak | Switzerland | Same shape, Swiss hosting |

Whichever you pick, the sending domain has to authorise them: the provider will give you an SPF
entry and DKIM records to publish. Publish them. A relay with no authorisation from your domain is a
stranger claiming to be you, and it is treated as one.

## Path 2: your own sending server

Everything below has to be true at once. Any one of them missing is enough to have mail quietly
discarded rather than rejected, and there is nothing Ruchoir can do about it.

1. **A fixed public address**, and outbound port 25 open from it. Most residential and many
   low-cost-VPS connections block it; some providers open it on request.
2. **A reverse DNS (PTR) record** for that address, resolving to the name the server announces in its
   HELO. Mismatched forward and reverse names is the single most common reason a message is refused
   at the door.
3. **SPF**: a TXT record on the sending domain listing that address as allowed to send for it.
4. **DKIM**: a signing key, published as a TXT record, with the server signing every outgoing
   message.
5. **DMARC**: a policy record saying what a receiver should do with a message failing the two above.
   Start at `p=none` and read the reports before tightening it.
6. **Patience.** A brand-new address has no reputation. Send little, send to people who expect it,
   and expect the first weeks to be worse than the months after.

## Testing it before you rely on it

The API's startup log is the first answer: `no SMTP relay configured` means nothing is leaving, and
the messages are in that log. Once a relay is set and the API restarted, that line is gone.

Then prove it end to end rather than assuming:

1. Ask for a password reset for an address you can read, and check that the message arrives at all.
2. Open its full headers and look for `spf=pass`, `dkim=pass` and `dmarc=pass`. A message that
   arrives with any of them failing is one filter rule away from stopping arriving.
3. Check the link in the body points at your instance and not at `localhost`.
4. Send one to a mailbox on a large consumer provider, not only to your own domain. Your own mail
   server trusts you; theirs is the one you need.

[mail-tester.com](https://www.mail-tester.com) (France) scores all of the above from a single message
and is the quickest way to see the whole picture. It is a third-party service: what you send it, it
sees, so send it a test message and not a real one.

## What the product does about all this

`GET /api/v1/instance` reports `email_delivery` without authentication, so the interface knows
whether to offer a flow that depends on a message. That is why an instance with no relay steers
invitations toward the addressed form (which activates the account outright) and offers recovery
codes and administrator-issued reset links instead of "we have sent you an email".

Configuring a relay does not take any of that away. The recovery paths stay: a relay that is
correctly set up today is a relay that can be down on the morning someone is locked out.
