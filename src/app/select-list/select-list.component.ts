import { Component, OnInit } from '@angular/core';
import { MatDialogRef } from '@angular/material';
import { ApplicationSettings } from '../manage/ApplicationSettings';

@Component({
  selector: 'app-select-list',
  templateUrl: './select-list.component.html',
  styleUrls: ['./select-list.component.scss']
})
export class SelectListComponent implements OnInit {

  constructor(private d: MatDialogRef<any>, public settings: ApplicationSettings) { }
  args: {
    options: selectListItem[];
    title: string;
    multiSelect?: boolean;
    onSelect: (selectedItems: selectListItem[]) => void
  }
  ngOnInit() {
  }
  select(item: selectListItem) {
    if (!this.args.multiSelect) {

      if (this.args.onSelect)
        this.args.onSelect([item]);
      this.close();
    }
    else {
      if (item.selected)
        item.selected = false;
      else
        item.selected = true;
    }
    return false;
  }
  confirm() {
    this.args.onSelect(this.args.options.filter(x => x.selected));
    this.close();
  }


  close() {
    this.d.close();
  }

}



export interface selectListItem<itemType = any> {
  name: string,
  item: itemType,
  selected?: boolean
}