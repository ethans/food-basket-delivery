import { Component, OnInit, Input, Output, EventEmitter, NgZone } from '@angular/core';

import * as copy from 'copy-to-clipboard';
import { DialogService, extractError } from '../select-popup/dialog';
import { DeliveryStatus } from '../families/DeliveryStatus';
import { Context, ServerFunction } from '@remult/core';

import { use } from '../translate';
import { UpdateCommentComponent } from '../update-comment/update-comment.component';


import { ActiveFamilyDeliveries } from '../families/FamilyDeliveries';
import { ApplicationSettings } from '../manage/ApplicationSettings';
import { createElementCssSelector } from '@angular/compiler';

import { HelperUserInfo, Helpers } from '../helpers/helpers';
import { getLang, Sites } from '../sites/sites';
import { Roles } from '../auth/roles';
import { PhoneColumn } from '../model-shared/types';

@Component({
  selector: 'app-family-info',
  templateUrl: './family-info.component.html',
  styleUrls: ['./family-info.component.scss']
})
export class FamilyInfoComponent implements OnInit {

  constructor(private dialog: DialogService, private context: Context, public settings: ApplicationSettings, private zone: NgZone) {

  }
  @Input() f: ActiveFamilyDeliveries;
  @Input() showHelp = false;
  ngOnInit() {
  }
  actuallyShowHelp() {
    return this.showHelp && this.f.deliverStatus.value != DeliveryStatus.ReadyForDelivery;
  }
  @Input() partOfAssign: Boolean;
  @Output() assignmentCanceled = new EventEmitter<void>();
  @Output() refreshList = new EventEmitter<void>();
  useWaze() {
    return this.settings.lang.languageCode == 'iw';
  }

  showCancelAssign(f: ActiveFamilyDeliveries) {
    return this.partOfAssign && f.courier.value != '' && f.deliverStatus.value == DeliveryStatus.ReadyForDelivery;
  }
  showFamilyPickedUp(f: ActiveFamilyDeliveries) {
    return f.deliverStatus.value == DeliveryStatus.SelfPickup;
  }

  async getPickupComments(f: ActiveFamilyDeliveries) {
    this.context.openDialog(UpdateCommentComponent, x => x.args =
    {
      family: f,
      comment: f.courierComments.value,
      helpText: s => s.commentForSuccessDelivery,
      ok: async (comment) => {
        f.deliverStatus.value = DeliveryStatus.SuccessPickedUp;
        f.courierComments.value = comment;
        f.checkNeedsWork();
        try {
          await f.save();
          this.dialog.analytics('Self Pickup');
        }
        catch (err) {
          this.dialog.Error(err);
        }
      },
      cancel: () => { }
    });
  }

  async labSelfReception(d: ActiveFamilyDeliveries) {
    if (await this.dialog.YesNoPromise(getLang(this.context).shouldArchiveDelivery)) {
      {
        d.archive.value = true;
        let user = <HelperUserInfo>this.context.user;
        d.distributionCenter.value = user.distributionCenter;
        d.deliverStatus.value = DeliveryStatus.Success;
        await d.save();
      }
    }
  }
  async privateCall() {
    try {
      this.dialog.analytics("Private Call");
      let r = await FamilyInfoComponent.privateCall(this.f.id.value);
      if (r.error)
        this.dialog.Error(r.error);
      else
        this.zone.run(() => {

          window.location.href = "tel:" + r.phone;
        });

    }
    catch (err) {
      this.dialog.exception("private clas", err);
    }

  }
  static createPhoneProxyOnServer: (phone1: string, phone2: string) => Promise<{ phone: string, session: string }>;
  @ServerFunction({ allowed: c => c.isSignedIn() })
  static async privateCall(deliveryId: string, context?: Context): Promise<{
    phone?: string,
    error?: string
  }> {
    let cleanPhone = '';
    let reqInfo = Sites.getOrganizationFromContext(context) + "/proxy/" + context.user.id + " => " + deliveryId;
    try {
      let settings = await ApplicationSettings.getAsync(context);
      if (!settings.usePhoneProxy.value)
        throw "פרוקסי לא מופעל לסביבה זו";
      let fd = await context.for(ActiveFamilyDeliveries).findId(deliveryId);
      if (!fd) throw "משלוח לא נמצא";
      if (fd.courier.value != context.user.id && !context.isAllowed([Roles.admin, Roles.distCenterAdmin]))
        throw "אינך רשאי לחייג למשפחה זו";

      cleanPhone = PhoneColumn.fixPhoneInput(fd.phone1.value);
      if (!cleanPhone) return { error: "למשפחה זו לא מעודכן טלפון" };
      if (cleanPhone.startsWith('0'))
        cleanPhone = cleanPhone.substring(1);
      cleanPhone = "+972" + cleanPhone;
      let h = await context.for(Helpers).findId(context.user.id);
      if (!h)
        throw "מתנדב לא נמצא";
      let vPhone = h.phone.value;
      if (vPhone.startsWith('0'))
        vPhone = vPhone.substring(1);
      vPhone = "+972" + vPhone;


      let r = await FamilyInfoComponent.createPhoneProxyOnServer(cleanPhone, vPhone);

      console.log(reqInfo + " (" + r.phone + "," + r.session + ")");
      return r;
    }
    catch (err) {
      console.error(reqInfo, err, "phone:" + cleanPhone);
      return { error: "תקלה בשירות הטלפונים: " + extractError(err) }
    }

  }

  async familiyPickedUp(f: ActiveFamilyDeliveries) {
    await (this.settings.isSytemForMlt()) ? this.labSelfReception(f) : this.getPickupComments(f);
  }

  async cancelAssign(f: ActiveFamilyDeliveries) {

    this.assignmentCanceled.emit();

  }
  openWaze(f: ActiveFamilyDeliveries) {
    if (!f.addressOk.value) {
      this.dialog.YesNoQuestion(use.language.addressNotOkOpenWaze, () => {
        if (this.useWaze())
          f.openWaze();
        else
          f.openGoogleMaps();
      });
    }
    else
      if (this.useWaze())
        f.openWaze();
      else
        f.openGoogleMaps();



  }
  udpateInfo(f: ActiveFamilyDeliveries) {
    f.showDetailsDialog({
      dialog: this.dialog,
      refreshDeliveryStats: () => {
        this.refreshList.emit();
      }
    });

  }
  copyAddress(f: ActiveFamilyDeliveries) {
    copy(f.address.value);
    this.dialog.Info(use.language.address + " " + f.address.value + " " + use.language.wasCopiedSuccefully);
  }
  showStatus() {
    return this.f.deliverStatus.value != DeliveryStatus.ReadyForDelivery && this.f.deliverStatus.value != DeliveryStatus.SelfPickup;
  }
}
