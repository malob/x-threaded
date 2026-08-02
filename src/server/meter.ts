import { NO_READS, addReceipts, receiptCount, receiptUsd, type Receipt } from "../shared/pricing";
import type { FetchCost } from "../shared/types";
import type { Billed } from "./xapi";

/**
 * One request's running estimate of what it spent at X.
 *
 * Charging is how a call's value gets unwrapped, so the accounting can't be
 * skipped without the code looking wrong, and the total survives a request
 * that throws halfway — the failure mode where money has moved and nothing
 * says so (2026-07-30 review, H1).
 *
 * Two sides, because X bills twice for nothing: the client reports what each
 * response returned, and callers that can see the store credit back the posts
 * it had already read on the same UTC calendar day, which X's dedup should
 * make free. That dedup is observed rather than contractual, so this is an
 * estimate on both sides (docs/x-api-notes.md N2).
 */
export class SpendMeter {
  private charged: Receipt = NO_READS;
  private credited: Receipt = NO_READS;

  /** Record what a call billed, and hand back what it returned. */
  charge<T>(billed: Billed<T>): T {
    this.charged = addReceipts(this.charged, billed.receipt);
    return billed.value;
  }

  /**
   * Record reads a failing call carried out with its error (see xapi's
   * spentOnFailure): the pages it bought before it threw billed all the same,
   * and never came back as a value anyone could charge.
   */
  absorb(receipt: Receipt): void {
    this.charged = addReceipts(this.charged, receipt);
  }

  /**
   * Forgive reads X's same-day dedup covers. Only ever posts this request also
   * charged for: crediting a post that arrived free from the store would net
   * out a read someone actually paid for.
   */
  credit(receipt: Receipt): void {
    this.credited = addReceipts(this.credited, receipt);
  }

  /** Whether any read has been charged — i.e. whether money may have moved. */
  get spent(): boolean {
    return receiptCount(this.charged) > 0;
  }

  /** The estimate as the API reports it. */
  cost(): FetchCost {
    // Clamped, so a credit that outruns its charge reads as free rather than
    // as a refund: the two are counted by different code paths, and the
    // arithmetic must not be able to hand back money.
    const net: Receipt = {
      reads: Math.max(0, this.charged.reads - this.credited.reads),
      ownedReads: Math.max(0, this.charged.ownedReads - this.credited.ownedReads),
      userReads: Math.max(0, this.charged.userReads - this.credited.userReads),
    };
    return {
      posts: receiptCount(this.charged),
      billable: receiptCount(net),
      usd: receiptUsd(net),
    };
  }
}
