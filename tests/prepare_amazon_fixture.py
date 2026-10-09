"""Convert an external MHTML capture to an offline HTML fixture (never into Git)."""
import base64
import html
import re
import sys
from email import policy
from email.parser import BytesParser
from pathlib import Path
from urllib.parse import urljoin

archive = BytesParser(policy=policy.default).parsebytes(Path(sys.argv[1]).read_bytes())
parts = [part for part in archive.walk() if not part.is_multipart()]
document = next(part for part in parts if part.get_content_type() == "text/html")
resources = {}
for part in parts:
    location = part.get("Content-Location")
    if location and part != document:
        resources[location] = part

def resource_url(location, seen=frozenset()):
    if location not in resources or location in seen:
        return "data:,"
    part = resources[location]
    content = part.get_payload(decode=True) or b""
    if part.get_content_type() == "text/css":
        css = content.decode(part.get_content_charset() or "utf-8", errors="replace")
        css = re.sub(r"url\(\s*(['\"]?)(.*?)\1\s*\)",
                     lambda match: 'url("' + resource_url(urljoin(location, match[2]), seen | {location}) + '")', css)
        content = css.encode()
    return "data:" + part.get_content_type() + ";base64," + base64.b64encode(content).decode()

markup = document.get_content()
# A saved capture cannot replay the site's server/session. Simulate updates in the runner.
markup = re.sub(r"<script\b[^>]*>.*?</script\s*>", "", markup, flags=re.S | re.I)
for location in sorted(resources, key=len, reverse=True):
    markup = markup.replace(html.escape(location, quote=True), resource_url(location))
    markup = markup.replace(location, resource_url(location))
Path(sys.argv[2]).write_text(markup, encoding="utf-8")
print(f"Offline fixture: {len(resources)} embedded resources")
