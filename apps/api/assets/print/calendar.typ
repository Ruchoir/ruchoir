// A printed calendar: one of five views, laid out from `data.json`.
//
// Every text comes from the data as a string and is set with `text(...)` or as a string in content:
// none of it is ever evaluated as markup, so a title holding `#`, `*` or `[` prints as typed.

#let data = json("data.json")
#let ink = rgb("#15171c")
#let muted = luma(105)
#let faint = luma(160)
#let rule = luma(215)

#set document(title: data.title)
// The Ruchoir mark and name: beside the title on the first page, at the top of the others.
#let mark = stack(dir: ltr, spacing: 5pt, image("mark.png", height: 16pt), align(horizon, text(11pt, weight: "bold", "Ruchoir")))

#set page(
  paper: "a4",
  header: context if counter(page).get().first() > 1 { align(right, mark) },
  flipped: data.landscape,
  margin: (x: 1.2cm, top: 1.2cm, bottom: 1.4cm),
  footer: context {
    set text(7pt, fill: muted)
    h(1fr)
    counter(page).display("1 / 1", both: true)
  },
)
#set text(font: "IBM Plex Sans", size: 9pt, fill: ink, lang: data.lang)
#set par(leading: 0.45em)

// The title, and the Ruchoir mark with its name on the right.
#grid(
  columns: (1fr, auto),
  align: horizon,
  text(15pt, weight: "bold", data.title),
  mark,
)
#v(8pt)

// One event: its calendar's colour, its time, its title and place.
#let entry(e, small: false) = {
  let size = if small { 7pt } else { 9pt }
  grid(
    columns: (3pt, 1fr),
    column-gutter: 4pt,
    box(width: 3pt, height: if small { 0.9em } else { 1.1em }, fill: rgb(e.color), radius: 1pt),
    {
      set text(size)
      if e.time != "" { text(fill: muted, e.time + " ") }
      text(weight: "bold", e.title)
      if e.place != none and not small { linebreak(); text(fill: muted, e.place) }
    },
  )
}

#let nothing = text(fill: muted, data.nothing)

#if data.view == "day" or data.view == "list" {
  if data.days.len() == 0 { nothing }
  for d in data.days {
    block(breakable: false, below: 10pt, {
      // The day view's title is its day already.
      if data.view == "list" {
        block(below: 5pt, text(10.5pt, weight: "bold", fill: if d.today { rgb("#d93f1a") } else { ink }, d.label))
      }
      if d.entries.len() == 0 { nothing } else {
        grid(
          columns: (2.8cm, 1fr),
          row-gutter: 6pt,
          ..d.entries.map(e => (text(fill: muted, e.slot), entry((..e, time: ""))) ).flatten(),
        )
      }
    })
  }
} else if data.view == "week" {
  grid(
    columns: (1fr,) * data.days.len(),
    column-gutter: 6pt,
    ..data.days.map(d => block(width: 100%, {
      block(
        width: 100%,
        below: 6pt,
        inset: (bottom: 4pt),
        stroke: (bottom: 0.6pt + rule),
        text(9pt, weight: "bold", fill: if d.today { rgb("#d93f1a") } else { ink }, d.label),
      )
      if d.entries.len() == 0 { text(7.5pt, fill: faint, "-") }
      for e in d.entries { block(below: 5pt, entry(e, small: true)) }
    })),
  )
} else if data.view == "month" {
  let weeks = calc.div-euclid(data.days.len(), 7)
  let height = if weeks > 5 { 2.55cm } else { 3.1cm }
  table(
    columns: (1fr,) * 7,
    rows: (auto,) + (height,) * weeks,
    stroke: 0.5pt + rule,
    inset: 3pt,
    ..data.columns.map(c => align(center, text(7.5pt, weight: "bold", fill: muted, c))),
    ..data.days.map(d => {
      block(below: 3pt, text(8pt, weight: "bold", fill: if d.today { rgb("#d93f1a") } else if d.faint { faint } else { ink }, str(d.number)))
      for e in d.entries { block(below: 2pt, entry(e, small: true)) }
      if d.more != none { text(6.5pt, fill: muted, d.more) }
    }),
  )
} else if data.view == "year" {
  // Every day in a cell of the same height, so a mark never pushes a line down.
  let cell(c) = box(width: 100%, height: 17pt, align(center + horizon, if c.number == none { [] } else if c.count > 3 {
    box(fill: rgb("#8fd0ff"), radius: 50%, width: 14pt, height: 14pt, align(center + horizon, text(7.5pt, weight: "bold", str(c.number))))
  } else if c.count > 0 {
    stack(spacing: 1.5pt, text(7.5pt, weight: "bold", str(c.number)), align(center, circle(radius: 1pt, fill: ink)))
  } else {
    text(7.5pt, str(c.number))
  }))
  grid(
    columns: (1fr,) * 4,
    column-gutter: 22pt,
    row-gutter: 16pt,
    ..data.months.map(m => block({
      block(below: 5pt, text(10pt, weight: "bold", m.name))
      grid(
        columns: (1fr,) * 7,
        ..data.initials.map(c => align(center, text(6.5pt, fill: muted, c))),
        ..m.cells.map(cell),
      )
    })),
  )
}
