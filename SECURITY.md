# Security policy

## Reporting a vulnerability

Please email **sales.bydtech@gmail.com** with the details, instead of opening a
public issue. We will acknowledge the report and keep you posted on the fix.

## Scope

`ai-cost-meter` makes no network requests and sends no usage data anywhere. It
reads the response objects you pass to it, keeps records in the store you give
it (memory by default), and writes only the log file you name in
`jsonlLogger()`. The CLI reads the price and log files you name, parsed as JSON
only. Reports about crafted responses, price files or log lines making it crash,
hang or write elsewhere are in scope. Records include your tags as you wrote
them; do not put secrets or personal data in tags.

Wrong or outdated prices are data bugs, not security issues: please open a
public issue with the provider's pricing page URL.
