import moment from "moment";
import { CSVAccountExport } from "./csvAccountExport";
import { customerPath } from "./ledger";
import { MainBook, User, Transaction } from "./mongodb";
import { ITransaction } from "./types";
import { LoggedError } from "./utils";
import { Balances } from "./interface"
const assert = require('assert')
import { sendNotification } from "./notification";

export abstract class UserWallet {

  static lastPrice: number
  user: typeof User // mongoose object
  readonly logger: any

  constructor({ user, logger }) {
    this.user = user
    this.logger = logger
  }

  // async refreshUser() {
  //   this.user = await User.findOne({ _id: this.uid })
  // }

  // TODO: upgrade price automatically with a timer
  static setCurrentPrice(price) {
    UserWallet.lastPrice = price
  }

  get accountPath(): string {
    return this.user.accountPath
  }

  get uid(): string {
    return this.user._id
  }

  static async usernameExists({ username }): Promise<boolean> {
    return !!(await User.findByUsername({ username }))
  }

  // this needs to be here to be able to call / chain updatePending()
  // otherwise super.updatePending() would result in an error
  // there may be better way to architecture this?
  async updatePending() { return }

  async getBalances(): Promise<Balances> {
    await this.updatePending()

    // TODO: add effective ratio
    const balances = {
      "BTC": 0,
      "USD": 0,
      total_in_BTC: NaN,
      total_in_USD: NaN,
    }

    // TODO: make this code parrallel instead of serial
    for (const { id } of this.user.currencies) {
      const { balance } = await MainBook.balance({
        account: this.user.accountPath,
        currency: id,
      })

      // balance shows an negative because they are a liability to the bank
      assert(balance <= 0)
      balances[id] = - balance
    }

    const priceMap = [
      {
        id: "BTC",
        BTC: 1,
        USD: 1/UserWallet.lastPrice, // TODO: check this should not be price
      },
      {
        id: "USD",
        BTC: UserWallet.lastPrice,
        USD: 1
      }
    ]
    
    // this array is used to know the total in USD and BTC
    // the effective ratio may not be equal to the user ratio 
    // as a result of price fluctuation
    let total = priceMap.map(({id, BTC, USD}) => ({
      id,
      value: BTC * balances["BTC"] + USD * balances["USD"]
    }))

    balances.total_in_BTC = total.filter(item => item.id === "BTC")[0].value
    balances.total_in_USD = total.filter(item => item.id === "USD")[0].value

    return balances
  }

  async getRawTransactions() {
    const { results } = await MainBook.ledger({
      // TODO: manage currencies

      // currency: this.currency,
      account: this.user.accountPath,
      // start_date: startDate,
      // end_date: endDate
    })

    return results
  }

  async getTransactions(): Promise<Array<ITransaction>> {
    const rawTransactions = await this.getRawTransactions()

    const results_processed = rawTransactions.map(item => {
      const amount = item.debit - item.credit
      const memoUsername =
        item.username ?
          amount > 0 ?
            `from ${item.username}` :
            `to ${item.username}` :
          null

      return {
        created_at: moment(item.timestamp).unix(),
        amount,
        sat: item.sat,
        usd: item.usd,
        description: item.memoPayer || item.memo || memoUsername || item.type, // TODO remove `|| item.type` once users have upgraded
        type: item.type,
        hash: item.hash,
        fee: item.fee,
        feeUsd: item.feeUsd,
        username: item.username,
        // destination: TODO
        pending: item.pending,
        id: item._id,
        currency: item.currency,
        addresses: item.payee_addresses,
      }
    })

    return results_processed
  }

  async getStringCsv() {
    const csv = new CSVAccountExport()
    await csv.addAccount({ account: customerPath(this.uid) })
    return csv.getBase64()
  }

  async setLevel({ level }) {
    this.user.level = level
    await this.user.save()
  }

  async setUsername({ username }): Promise<boolean | Error> {

    const result = await User.findOneAndUpdate({ _id: this.uid, username: null }, { username })

    if (!result) {
      const error = `Username is already set`
      this.logger.error({ result }, error)
      throw new LoggedError(error)
    }

    return true
  }

  async setLanguage({ language }): Promise<boolean | Error> {

    const result = await User.findOneAndUpdate({ _id: this.uid, }, { language })

    if (!result) {
      const error = `issue setting language preferences`
      this.logger.error({ result }, error)
      throw new LoggedError(error)
    }

    return true
  }

  static getCurrencyEquivalent({ sats, fee, usd }: { sats: number, fee?: number, usd?: number }) {
    return {
      fee, 
      feeUsd: fee ? UserWallet.satsToUsd(fee): undefined,
      sats,
      usd: usd ?? UserWallet.satsToUsd(sats)
    }
  }
  
  static satsToUsd = sats => {
    const usdValue = UserWallet.lastPrice * sats
    return usdValue
  }

  isUserActive = async (): Promise<boolean> => {
    const timestamp30DaysAgo = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000))
    const [result] = await Transaction.aggregate([
      { $match: { "accounts": this.accountPath, "timestamp": { $gte: timestamp30DaysAgo } } },
      {
        $group: {
          _id: null, outgoingSats: { $sum: "$credit" }, incomingSats: { $sum: "$debit" }
        }
      }
    ])
    const { incomingSats, outgoingSats } = result || {}

    return (outgoingSats > 1000 || incomingSats > 1000)
  }

  sendBalance = async () => {
    const {BTC: balanceSats} = await this.getBalances()

    // Add commas to balancesats
    const balanceSatsPrettified = balanceSats.toLocaleString("en")
    // Round balanceusd to 2 decimal places and add commas
    const balanceUsd = UserWallet.satsToUsd(balanceSats).toLocaleString("en", { maximumFractionDigits: 2 })

    this.logger.info({ balanceSatsPrettified, balanceUsd, user: this.user }, `sending balance notification to user`)
    await sendNotification({ user: this.user, title: `Your balance today is \$${balanceUsd} (${balanceSatsPrettified} sats)`, logger: this.logger })
  }
}
