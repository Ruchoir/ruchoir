"""Convert one office document to PDF with LibreOffice, for the file viewer.

Run by `files::convert` as `python3 convert.py <input> <output> <profile dir>`; the input's
extension tells LibreOffice the format. An output ending in `.png` is the first page as a picture
(a shared document's page on a phone, where a PDF does not show inside a page) rather than a PDF. It drives LibreOffice through its UNO bridge rather than the
plain `--convert-to` switch because a preview needs two things that switch cannot do: a CSV has to
be read with the right separator and encoding (there is no header to say which), and a spreadsheet
has to be laid out for looking at, in landscape and fitted to the page width, rather than cut into
portrait pages that split the columns. Text documents and presentations keep their own page layout.

Exit status 0 means the PDF was written. A hard deadline ends LibreOffice itself, so a stuck
conversion leaves no process behind.
"""

import os
import subprocess
import sys
import threading
import time

import uno
from com.sun.star.beans import PropertyValue
from com.sun.star.connection import NoConnectException

DEADLINE_SECONDS = 75


def prop(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def csv_filter_options(path):
    """The import options of a CSV: its separator and its character set, guessed from the start."""
    with open(path, "rb") as f:
        head = f.read(65536)
    charset = 76  # UTF-8
    try:
        head.decode("utf-8")
    except UnicodeDecodeError as error:
        # A cut in the middle of a character at the end of the sample is not a different encoding.
        if error.start < len(head) - 4:
            charset = 1  # Windows-1252, what a spreadsheet on Windows writes
    first_line = head.split(b"\n", 1)[0]
    counts = {59: first_line.count(b";"), 44: first_line.count(b","), 9: first_line.count(b"\t"), 124: first_line.count(b"|")}
    separator = max(counts, key=counts.get) if any(counts.values()) else 44
    return "%d,34,%d,1" % (separator, charset)


def lay_out_spreadsheet(doc):
    """Landscape, and as wide as the page: every column visible, the rows running over as many pages as needed."""
    styles = doc.StyleFamilies.getByName("PageStyles")
    for name in styles.ElementNames:
        style = styles.getByName(name)
        width, height = style.Width, style.Height
        if width < height:
            style.IsLandscape = True
            style.Width, style.Height = height, width
        style.ScaleToPagesX = 1
        style.ScaleToPagesY = 0


def main():
    source, target, profile = sys.argv[1:4]
    pipe = "ruchoir-convert-%d" % os.getpid()
    office = subprocess.Popen(
        [
            "soffice", "--headless", "--norestore", "--nologo", "--nodefault", "--nolockcheck",
            "-env:UserInstallation=file://" + profile,
            "--accept=pipe,name=%s;urp;" % pipe,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    def give_up():
        office.kill()
        os._exit(1)

    watchdog = threading.Timer(DEADLINE_SECONDS, give_up)
    watchdog.daemon = True
    watchdog.start()

    context = uno.getComponentContext()
    resolver = context.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", context)
    remote = None
    while remote is None:
        if office.poll() is not None:
            sys.exit(1)
        try:
            remote = resolver.resolve("uno:pipe,name=%s;urp;StarOffice.ComponentContext" % pipe)
        except NoConnectException:
            time.sleep(0.25)
    desktop = remote.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", remote)

    status = 1
    doc = None
    try:
        arguments = [prop("Hidden", True), prop("ReadOnly", True)]
        if source.lower().endswith(".csv"):
            arguments += [prop("FilterName", "Text - txt - csv (StarCalc)"), prop("FilterOptions", csv_filter_options(source))]
        doc = desktop.loadComponentFromURL(uno.systemPathToFileUrl(source), "_blank", 0, tuple(arguments))
        if doc is None:
            sys.exit(1)
        kind = "pdf" if not target.lower().endswith(".png") else "png"
        if doc.supportsService("com.sun.star.sheet.SpreadsheetDocument"):
            lay_out_spreadsheet(doc)
            export = "calc_%s_Export" % kind
        elif doc.supportsService("com.sun.star.presentation.PresentationDocument"):
            export = "impress_%s_Export" % kind
        else:
            export = "writer_%s_Export" % kind
        doc.storeToURL(uno.systemPathToFileUrl(target), (prop("FilterName", export),))
        status = 0
    finally:
        try:
            if doc is not None:
                doc.close(True)
            desktop.terminate()
        except Exception:
            pass
        try:
            office.wait(timeout=10)
        except subprocess.TimeoutExpired:
            office.kill()
    sys.exit(status)


main()
