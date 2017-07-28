# Apple Sales Bot

Post daily Apple sales report summaries to Slack

## Instructions

1. Run `npm run package`
2. Create an AWS Lambda script from `apple-sales-bot.zip`
3. Set the following environment variables for the Lambda script:
   - **APPLE_USER_ID** - Your iTunes Connect email address
   - **APPLE_ACCESS_TOKEN** - Your iTunes Connect Access Token ([instructions](https://www.google.com/search?q=Generate+access+token+in+iTunes+Connect))
   - **APPLE_VENDOR_NUMBER** - Your [Apple Vendor ID](https://apple.stackexchange.com/questions/65267/how-do-i-find-out-what-my-apple-vendor-id-is)
   - **OPEN_EXCHANGE_RATES_APP_ID** - An access token for [Open Exchange Rates](https://openexchangerates.org/)
   - **S3_PERSIST_URL** - An S3 URL for a file that will be created by the Lambda script, ex: s3://my-salesbot/lastrun.txt
   - **SLACK_WEBHOOK** - An incoming Slack webhook the script will post to
4. Setup a Scheduled Event trigger for the Lambda script to run at a regular interval such as hourly ([instructions](http://docs.aws.amazon.com/lambda/latest/dg/with-scheduled-events.html))
