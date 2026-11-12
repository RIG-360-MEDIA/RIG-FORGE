"""Hindi typed in the Kruti Dev font, converted to Unicode.

Kruti Dev is a legacy Hindi typing font: the PDF stores Latin keystrokes
and the font draws them as Devanagari, so the text extracts as "600 rd
7-5 lsV cSd" where the page shows "600 तक 7.5 सेट बैक". Government bylaws
are often typed this way (the MDDA Uttarakhand bylaws, Nov 2026). Reading
that text through OCR lost decimal points ("7.5" -> "75") and misread
words ("सेट बैक" -> "पेट बैक"); converting it gives the exact text.

Only spans in a Kruti Dev font are converted (kruti_fonts decides which
fonts of a document are), so English typed in another font is untouched.
The mapping and the two reordering rules (the ि sign typed before its
consonant, the reph typed after it) follow the widely used Kruti Dev 010
to Unicode converter.
"""

import re

# Kruti Dev keystrokes -> Unicode, applied in this order (longer first).
_MAP = [
    ("ñ", "॰"), ("Q+Z", "QZ+"), ("sas", "sa"), ("aa", "a"), (")Z", "र्द्ध"), ("ZZ", "Z"),
    ("å", "०"), ("ƒ", "१"), ("„", "२"), ("…", "३"), ("†", "४"), ("‡", "५"), ("ˆ", "६"), ("‰", "७"), ("Š", "८"), ("‹", "९"),
    ("¶+", "फ़्"), ("d+", "क़"), ("[+k", "ख़"), ("[+", "ख़्"), ("x+", "ग़"), ("T+", "ज़्"), ("t+", "ज़"), ("M+", "ड़"), ("<+", "ढ़"),
    ("Q+", "फ़"), (";+", "य़"), ("j+", "ऱ"), ("u+", "ऩ"),
    ("Ùk", "त्त"), ("Ù", "त्त्"), ("ä", "क्त"), ("–", "दृ"), ("—", "कृ"), ("é", "न्न"), ("™", "न्न्"), ("=kk", "=k"), ("f=k", "f="),
    ("à", "ह्न"), ("á", "ह्य"), ("â", "हृ"), ("ã", "ह्म"), ("ºz", "ह्र"), ("º", "ह्"), ("í", "द्द"), ("{k", "क्ष"), ("{", "क्ष्"),
    ("=", "त्र"), ("«", "त्र्"),
    ("Nî", "छ्य"), ("Vî", "ट्य"), ("Bî", "ठ्य"), ("Mî", "ड्य"), ("<î", "ढ्य"), ("|", "द्य"), ("K", "ज्ञ"), ("}", "द्व"),
    ("J", "श्र"), ("Vª", "ट्र"), ("Mª", "ड्र"), ("<ªª", "ढ्र"), ("Nª", "छ्र"), ("Ø", "क्र"), ("Ý", "फ्र"), ("nzZ", "र्द्र"),
    ("æ", "द्र"), ("ç", "प्र"), ("Á", "प्र"), ("xz", "ग्र"), ("#", "रु"), (":", "रू"),
    ("v‚", "ऑ"), ("vks", "ओ"), ("vkS", "औ"), ("vk", "आ"), ("v", "अ"), ("b±", "ईं"), ("Ã", "ई"), ("bZ", "ई"), ("b", "इ"),
    ("m", "उ"), ("Å", "ऊ"), (",s", "ऐ"), (",", "ए"), ("_", "ऋ"),
    ("ô", "क्क"), ("d", "क"), ("Dk", "क"), ("D", "क्"), ("[k", "ख"), ("[", "ख्"), ("x", "ग"), ("Xk", "ग"), ("X", "ग्"),
    ("Ä", "घ"), ("?k", "घ"), ("?", "घ्"), ("³", "ङ"),
    ("p", "च"), ("Pk", "च"), ("P", "च्"), ("N", "छ"), ("t", "ज"), ("Tk", "ज"), ("T", "ज्"), (">", "झ"),
    ("÷", "झ्"), ("¥", "झ"),
    ("ê", "ट्ट"), ("ë", "ट्ठ"), ("V", "ट"), ("B", "ठ"), ("ì", "ड्ड"), ("ï", "ड्ढ"), ("M", "ड"), ("<", "ढ"),
    (".k", "ण"), (".", "ण्"),
    ("r", "त"), ("Rk", "त"), ("R", "त्"), ("Fk", "थ"), ("F", "थ्"), (")", "द्ध"), ("n", "द"), ("/k", "ध"), ("èk", "ध"),
    ("/", "ध्"), ("Ë", "ध्"), ("è", "ध्"), ("u", "न"), ("Uk", "न"), ("U", "न्"),
    ("i", "प"), ("Ik", "प"), ("I", "प्"), ("Q", "फ"), ("¶", "फ्"), ("c", "ब"), ("Ck", "ब"), ("C", "ब्"), ("Hk", "भ"), ("H", "भ्"),
    ("e", "म"), ("Ek", "म"), ("E", "म्"),
    (";", "य"), ("¸", "य्"), ("j", "र"), ("y", "ल"), ("Yk", "ल"), ("Y", "ल्"), ("G", "ळ"), ("o", "व"), ("Ok", "व"), ("O", "व्"),
    ("'k", "श"), ("'", "श्"), ('"k', "ष"), ('"', "ष्"), ("l", "स"), ("Lk", "स"), ("L", "स्"), ("g", "ह"),
    ("È", "ीं"), ("z", "्र"),
    ("Ì", "द्द"), ("Í", "ट्ट"), ("Î", "ट्ठ"), ("Ï", "ड्ड"), ("Ñ", "कृ"), ("Ò", "भ"), ("Ó", "्य"), ("Ô", "ड्ढ"), ("Ö", "झ्"),
    ("Ük", "श"), ("Ü", "श्"),
    ("‚", "ॉ"), ("ks", "ो"), ("kS", "ौ"), ("k", "ा"), ("h", "ी"), ("q", "ु"), ("w", "ू"), ("`", "ृ"), ("s", "े"), ("S", "ै"),
    ("a", "ं"), ("¡", "ँ"), ("W", "ॅ"), ("•", "ऽ"), ("·", "ऽ"), ("∙", "ऽ"), ("~j", "्र"), ("~", "्"), ("\\", "?"), ("+", "़"),
    ("^", "‘"), ("*", "’"), ("Þ", "“"), ("ß", "”"), ("¼", "("), ("½", ")"), ("¿", "{"), ("À", "}"), ("¾", "="),
    ("A", "।"), ("-", "."), ("&", "-"), ("Œ", "µ"), ("]", ","), ("@", "/"),
    ("ाे", "ो"), ("ाॅ", "ॉ"), ("ंै", "ैं"), ("े्र", "्रे"), ("अौ", "औ"), ("अो", "ओ"), ("आॅ", "ऑ"),
]

# Word turns the ' and " keys into curly quotes; in Kruti Dev text they are
# still श् and ष् (the MDDA bylaws: "vko’;d" = आवश्यक, "i`”B" = पृष्ठ).
_QUOTES = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"'})

_MATRAS = set("ािीुूृेैोौंःँॅ")
_HALANT = "्"


def to_unicode(text: str) -> str:
    """Kruti Dev keystrokes -> Unicode Devanagari."""
    s = text.translate(_QUOTES)
    for k, v in _MAP:
        s = s.replace(k, v)
    # % is the visarga, or a colon after a space ("मल्टीफ्लेक्स :"). After the
    # map, which turns ":" into रू.
    s = re.sub(r"(?<=\s)%|^%", ":", s).replace("%", "ः")
    # ि is typed before its consonant: move it after the consonant, and after
    # a whole conjunct (f + स् + थ -> स्थि).
    s = re.sub(r"f(.)", "\\1ि", s)
    while True:
        t = re.sub(r"ि्(.)", "्\\1ि", s)
        if t == s:
            break
        s = t
    # The reph (Z) is typed after the syllable it sits on: put र् before that
    # syllable's consonant cluster (ik'oZ -> पा + र्श्व).
    while True:
        i = s.find("Z")
        if i < 0:
            break
        j = i - 1
        while j > 0 and s[j] in _MATRAS:
            j -= 1
        while j >= 2 and s[j - 1] == _HALANT:
            j -= 2
        j = max(j, 0)
        s = s[:j] + "र्" + s[j:i] + s[i + 1:]
    return s


# Common Hindi words as typed in Kruti Dev: का के की में से तक है और या को हो न
# किया किसी होगा होंगे अथवा तथा द्वारा अनुसार.
_KRUTI_WORDS = frozenset("dk ds dh esa ls rd gS vkSj ;k dks gks u fd;k fdlh gksxk gksaxs vFkok rFkk }kjk vuqlkj".split())
_ENGLISH = frozenset("the of and to in a is for be shall with by on as or at from that this are".split())


def kruti_fonts(doc, sample_pages: int = 40) -> set:
    """The fonts of a PDF that hold Kruti Dev text: their words are often
    common Hindi words as typed in Kruti Dev and rarely English ones."""
    words = {}
    for page in doc.pages(0, min(sample_pages, doc.page_count)):
        for b in page.get_text("dict").get("blocks", []):
            for line in b.get("lines", []):
                for span in line.get("spans", []):
                    words.setdefault(span["font"], []).extend(span["text"].split())
    out = set()
    for font, ws in words.items():
        if len(ws) < 20:
            continue
        kruti = sum(1 for w in ws if w in _KRUTI_WORDS) / len(ws)
        english = sum(1 for w in ws if w.lower() in _ENGLISH) / len(ws)
        if kruti >= 0.04 and kruti > 2 * english:
            out.add(font)
    return out


def page_text(page, fonts: set) -> str:
    """The page's text as get_text() lays it out, with runs of spans in a
    Kruti Dev font converted (converted per run: ि and the reph can sit in
    the span next to their consonant)."""
    if not fonts:
        return page.get_text()
    out = []
    for b in page.get_text("dict").get("blocks", []):
        if b.get("type", 0) != 0:
            continue
        for line in b.get("lines", []):
            parts, run = [], []
            for span in line.get("spans", []):
                if span["font"] in fonts:
                    run.append(span["text"])
                    continue
                if run:
                    parts.append(to_unicode("".join(run)))
                    run = []
                parts.append(span["text"])
            if run:
                parts.append(to_unicode("".join(run)))
            out.append("".join(parts))
    return "\n".join(out) + ("\n" if out else "")
