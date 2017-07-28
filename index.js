const AppleReporter = require('apple-reporter')
const S3 = require('aws-sdk/clients/s3')
const moment = require('moment')
const request = require('request')

const INSTALL_TYPES = new Set(['1', '1F', '1T', 'F1', '1E', '1EP', '1EU'])
const IAP_TYPES = new Set(['IA1', 'IA9', 'IAY', 'IAC', 'FI1'])
const MAX_ATTACHMENTS = 20
const NO_REPORT_ERRORS = new Set([210, 211, 212])
const ERR_NO_SALES = 213

exports.handler = (event, context, callback) => {
  const opts = {
    appleUserID: process.env.APPLE_USER_ID,
    appleAccessToken: process.env.APPLE_ACCESS_TOKEN,
    appleVendor: process.env.APPLE_VENDOR_NUMBER,
    openFXRatesAppID: process.env.OPEN_EXCHANGE_RATES_APP_ID,
    s3PersistUrl: process.env.S3_PERSIST_URL,
    slackWebhook: process.env.SLACK_WEBHOOK
  }

  if (!opts.appleUserID) return callback(`APPLE_USER_ID is not set`)
  if (!opts.appleAccessToken) return callback(`APPLE_ACCESS_TOKEN is not set`)
  if (!opts.appleVendor) return callback(`APPLE_VENDOR_NUMBER is not set`)
  if (!opts.openFXRatesAppID)
    return callback(`OPEN_EXCHANGE_RATES_APP_ID is not set`)
  if (!opts.s3PersistUrl) return callback(`S3_PERSIST_URL is not set`)
  if (!opts.slackWebhook) return callback(`SLACK_WEBHOOK is not set`)

  tryReportSales(opts)
    .then(status => callback(null, status))
    .catch(err => callback(err))
}

function tryReportSales(opts) {
  const s3 = new S3()
  const reporter = new AppleReporter({
    userid: opts.appleUserID,
    accesstoken: opts.appleAccessToken
  })

  let date

  return checkSalesReportStatus(reporter)
    .then(_ => getLastDate(s3, opts.s3PersistUrl))
    .then(lastDate => {
      date = lastDate ? lastDate.add(1, 'days') : moment.utc().add(-2, 'days')
      console.log(`Setting reporting date to ${date.format('YYYY-MM-DD')}`)
    })
    .then(_ =>
      getSalesForDate(reporter, opts.appleVendor, date, opts.openFXRatesAppID)
    )
    .then(sales => {
      if (!sales) return 'No new sales report'

      return getAllAppInfo(sales)
        .then(sales => buildSlackMessage(sales, date))
        .then(msg => postToSlack(opts.slackWebhook, msg))
        .then(_ => setLastDate(s3, opts.s3PersistUrl, date))
        .then(_ => 'Success')
    })
}

function checkSalesReportStatus(reporter) {
  console.log(`Checking sales report status...`)

  return reporter.Sales.getStatus().then(status => {
    if (
      !status ||
      !status.Status ||
      !status.Status.Message ||
      !status.Status.Message.length
    ) {
      const msg = `Unrecognized Sales Report status: ${JSON.stringify(status)}`
      throw new Error(msg)
    }

    console.log(status.Status.Message[0])
  })
}

function getSalesForDate(reporter, vendor, date, openFXRatesAppID) {
  const prevDate = moment(date).add(-1, 'days')
  const prevWeekDate = moment(date).add(-1, 'weeks')
  const results = { day: null, prevDay: null, prevWeek: null }

  // Try to fetch sales for the current date first
  return getDailySales(reporter, vendor, date).then(report => {
    // Early terminate if the sales report is not available yet
    if (!report) return null

    // Fetch current USD exchange rates
    return getExchangeRates(openFXRatesAppID).then(rates => {
      results.day = parseSalesReport(report, rates)

      // Early terminate if there were no sales
      if (!Object.keys(results.day).length) return results

      // Fetch sales for one day ago and seven days ago
      return getDailySales(reporter, vendor, prevDate)
        .then(report => (results.prevDay = parseSalesReport(report, rates)))
        .then(_ => getDailySales(reporter, vendor, prevWeekDate))
        .then(report => (results.prevWeek = parseSalesReport(report, rates)))
        .then(_ => results)
    })
  })
}

function getDailySales(reporter, vendor, date) {
  const opts = {
    vendorNumber: vendor,
    reportType: 'Sales',
    reportSubType: 'Summary',
    dateType: 'Daily',
    date: moment(date).format('YYYYMMDD')
  }

  console.log(
    `POST https://reportingitc-reporter.apple.com/reportservice/sales/v1 (${vendor} @ ${opts.date})`
  )
  return reporter.Sales
    .getReport(opts)
    .then(text =>
      text
        .split('\n')
        .filter(row => row.length > 1)
        .map(row => row.split('\t').map(cell => cell.trim() || null))
    )
    .catch(err => {
      const code = Number(err.code)

      if (NO_REPORT_ERRORS.has(code)) {
        console.log(err.message)
        return null
      }

      if (code === ERR_NO_SALES) {
        console.log(err.message)
        return []
      }

      throw err
    })
}

function parseSalesReport(report, rates) {
  const apps = {}

  if (report.length < 2) return apps

  const header = report[0]
  const idxAppID = header.indexOf('Apple Identifier')
  const idxCountry = header.indexOf('Country Code')
  const idxCurrency = header.indexOf('Currency of Proceeds')
  const idxTitle = header.indexOf('Title')
  const idxUnits = header.indexOf('Units')
  const idxRevenue = header.indexOf('Developer Proceeds')
  const idxType = header.indexOf('Product Type Identifier')

  report.slice(1).forEach(row => {
    const appID = row[idxAppID]

    let app = apps[appID]
    if (!app) {
      app = {
        title: row[idxTitle],
        country: row[idxCountry],
        icon: null,
        installs: 0,
        revenue: 0
      }
      apps[appID] = app
    }

    const type = row[idxType]
    const units = Number(row[idxUnits]) || 0
    const localRevenue = Number(row[idxRevenue]) || 0
    const currency = row[idxCurrency]
    const fxRate = rates[currency]

    if (fxRate !== undefined) {
      if (INSTALL_TYPES.has(type)) {
        app.installs += units
        app.revenue += units * localRevenue * (1 / fxRate)
      } else if (IAP_TYPES.has(type)) {
        app.revenue += units * localRevenue * (1 / fxRate)
      }
    } else {
      console.warn(`Unrecognized proceeds: ${localRevenue} ${currency}`)
    }
  })

  return apps
}

function getExchangeRates(fxAppID) {
  return new Promise((resolve, reject) => {
    const url = `http://openexchangerates.org/api/latest.json?app_id=${fxAppID}`
    console.log(`GET ${url}`)

    request({ url: url, json: true }, (err, res, body) => {
      if (err) return reject(err)

      if (!body || !body.rates) {
        const msg = `Unrecognized response from ${url}\n${JSON.stringify(body)}`
        return reject(msg)
      }

      body.rates.USD = 1
      resolve(body.rates)
    })
  })
}

function getAllAppInfo(sales) {
  const tasks = Object.keys(sales.day).map(appID => {
    return getAppInfo(appID, sales.day[appID].country).then(info => {
      sales.day[appID].icon = info.icon
    })
  })

  return Promise.all(tasks).then(_ => sales)
}

function getAppInfo(appID, country) {
  return new Promise((resolve, reject) => {
    const url = `http://itunes.apple.com/lookup?id=${appID}&country=${country}`
    console.log(`GET ${url}`)

    request({ url: url, json: true }, (err, res, body) => {
      if (err) return reject(err)

      if (
        !body ||
        !body.results ||
        !body.results.length ||
        !body.results[0].trackName ||
        !body.results[0].artworkUrl60
      ) {
        const msg = `Unrecognized response from ${url}\n${JSON.stringify(body)}`
        return reject(msg)
      }

      const first = body.results[0]
      resolve({ title: first.trackName, icon: first.artworkUrl60 })
    })
  })
}

function getLastDate(s3, s3Url) {
  return new Promise((resolve, reject) => {
    const parts = require('url').parse(s3Url)
    if (parts.protocol !== 's3:')
      return reject(new Error(`Invalid S3 URL ${s3Url}`))

    console.log(`GET ${s3Url}`)

    const params = {
      Bucket: parts.hostname,
      Key: parts.pathname.slice(1),
      ResponseContentEncoding: 'text/plain; charset=utf-8'
    }

    s3.getObject(params, (err, data) => {
      if (err) {
        if (err.code === 'NoSuchKey') return resolve(null)
        return reject(err)
      }

      const date = moment(data.Body, 'YYYY-MM-DD')
      if (!date.isValid()) return reject(new Error(`Invalid date in ${s3Url}`))

      resolve(date)
    })
  })
}

function setLastDate(s3, s3Url, date) {
  return new Promise((resolve, reject) => {
    const parts = require('url').parse(s3Url)
    if (parts.protocol !== 's3:')
      return reject(new Error(`Invalid S3 URL ${s3Url}`))

    const body = moment(date).format('YYYY-MM-DD')
    console.log(`SET ${s3Url} ${body}`)

    const params = {
      Bucket: parts.hostname,
      Key: parts.pathname.slice(1),
      ContentType: 'text/plain',
      Body: body
    }

    s3.putObject(params, (err, data) => {
      if (err) return reject(err)
      resolve(data)
    })
  })
}

function postToSlack(webhook, data) {
  return new Promise((resolve, reject) => {
    console.log(`POST ${webhook}`)
    request.post({ url: webhook, body: data, json: true }, (err, res, body) => {
      if (err) return reject(err)
      resolve()
    })
  })
}

function buildSlackMessage(sales, date) {
  const dateStr = moment(date).format('MMMM D, YYYY')

  if (!Object.keys(sales.day).length)
    return { text: `No app sales on ${dateStr}` }

  const msg = { attachments: [] }

  const totalInstalls = {
    day: 0,
    prevDay: 0,
    prevWeek: 0
  }
  const totalRevenue = {
    day: 0,
    prevDay: 0,
    prevWeek: 0
  }

  const appIDs = Object.keys(sales.day).sort((a, b) =>
    sales.day[a].title.localeCompare(sales.day[b].title)
  )

  appIDs.forEach(appID => {
    const app = sales.day[appID]
    const prevDayApp = sales.prevDay[appID] || { installs: 0, revenue: 0 }
    const prevWeekApp = sales.prevWeek[appID] || { installs: 0, revenue: 0 }

    const isGood = app.revenue
      ? app.revenue > prevDayApp.revenue
      : app.installs > prevDayApp.installs

    totalInstalls.day += app.installs
    totalInstalls.prevDay += prevDayApp.installs
    totalInstalls.prevWeek += prevWeekApp.installs

    totalRevenue.day += app.revenue
    totalRevenue.prevDay += prevDayApp.revenue
    totalRevenue.prevWeek += prevWeekApp.revenue

    msg.attachments.push({
      fallback: '',
      color: isGood ? 'good' : 'danger',
      author_name: app.title,
      author_icon: app.icon,
      fields: createFields(
        app.installs,
        app.revenue,
        prevDayApp.installs,
        prevDayApp.revenue,
        prevWeekApp.installs,
        prevWeekApp.revenue
      )
    })
  })

  // Remove excess attachments
  if (msg.attachments.length > MAX_ATTACHMENTS)
    msg.attachments = msg.attachments.slice(0, MAX_ATTACHMENTS)

  // Add "Totals" info as the first attachment
  const isTotalGood = totalRevenue.day
    ? totalRevenue.day > totalRevenue.prevDay
    : totalInstalls.day > totalInstalls.prevDay
  const text = `Daily Analytics for ${dateStr}`
  msg.attachments.unshift({
    fallback: text,
    color: isTotalGood ? 'good' : 'danger',
    pretext: text,
    title: 'Totals',
    fields: createFields(
      totalInstalls.day,
      totalRevenue.day,
      totalInstalls.prevDay,
      totalRevenue.prevDay,
      totalInstalls.prevWeek,
      totalRevenue.prevWeek
    )
  })

  return msg
}

function createFields(
  installs,
  revenue,
  prevDayInstalls,
  prevDayRevenue,
  prevWeekInstalls,
  prevWeekRevenue
) {
  const fields = [
    {
      title: 'Downloads',
      value: formatNumber(installs),
      short: true
    }
  ]

  if (revenue) {
    fields.push({
      title: 'Revenue',
      value: formatCurrency(revenue),
      short: true
    })
  }

  fields.push({
    value: formatPercentsField(installs, prevDayInstalls, prevWeekInstalls),
    short: true
  })

  if (revenue) {
    fields.push({
      value: formatPercentsField(revenue, prevDayRevenue, prevWeekRevenue),
      short: true
    })
  }

  return fields
}

function formatNumber(value) {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatPercent(value) {
  const plus = value >= 0 ? '+' : ''
  const num = (value * 100).toFixed(1).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${plus}${num}%`
}

function formatPercentsField(dayValue, prevDayValue, prevWeekValue) {
  const dayPct = prevDayValue
    ? (dayValue - prevDayValue) / Math.abs(prevDayValue)
    : 1
  const weekPct = prevWeekValue
    ? (dayValue - prevWeekValue) / Math.abs(prevWeekValue)
    : 1
  return `${formatPercent(dayPct)} day / ${formatPercent(weekPct)} week`
}

function formatCurrency(value) {
  const minus = value < 0 ? '-' : ''
  const sig = Math.abs(value) >= 100 ? 0 : 2
  const num = Math.abs(value).toFixed(sig).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${minus}$${num}`
}

////////////////////////////////////////////////////////////////////////////////
// Run direct from CLI
////////////////////////////////////////////////////////////////////////////////

if (!process.env.LAMBDA_TASK_ROOT) {
  exports.handler(null, null, (err, res) => {
    if (err) {
      console.error(err)
      process.exit(1)
    }

    console.log(res)
  })
}
